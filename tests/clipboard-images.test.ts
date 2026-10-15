import { describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import {
  attachmentMarkdown,
  clipboardImageFiles,
  importClipboardImages,
  MAX_CLIPBOARD_IMAGE,
} from '../src/clipboard-images';
import { imagePasteExtension } from '../src/image-paste-extension';

const target = { root: '/test/notebook', id: 'note-a', path: 'Folder/Note.md' };
function image() {
  const file = new File(['png'], 'image.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', {
    configurable: true,
    value: async () => new Uint8Array([137, 80, 78, 71]).buffer,
  });
  return file;
}
function clipboard(file: File): DataTransfer {
  return {
    items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
    files: [file],
  } as unknown as DataTransfer;
}
function paste(view: EditorView, data: DataTransfer) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: data });
  view.contentDOM.dispatchEvent(event);
  return event;
}

describe('Clipboard image imports', () => {
  it('finds clipboard screenshot files once and leaves ordinary text and unsafe formats alone', () => {
    const file = image();
    expect(clipboardImageFiles(clipboard(file))).toEqual([file]);
    expect(clipboardImageFiles({ items: [], files: [file] } as unknown as DataTransfer)).toEqual([
      file,
    ]);
    expect(
      clipboardImageFiles(clipboard(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }))),
    ).toEqual([]);
    expect(
      clipboardImageFiles({
        items: [{ kind: 'string', type: 'text/plain' }],
        files: [],
      } as unknown as DataTransfer),
    ).toEqual([]);
    expect(clipboardImageFiles(null)).toEqual([]);
  });

  it('imports bytes with explicit notebook/note identity and produces a relative Markdown link', async () => {
    const importer = vi.fn().mockResolvedValue('attachments/1234abcd-pasted-image.png');
    const markdown = await importClipboardImages([image()], target, () => true, importer);
    expect(importer).toHaveBeenCalledWith({
      expectedRoot: target.root,
      noteId: target.id,
      mime: 'image/png',
      bytes: [137, 80, 78, 71],
    });
    expect(markdown).toBe('![pasted-image.png](../attachments/1234abcd-pasted-image.png)');
  });

  it('encodes reserved URL characters and escapes Markdown alt labels for picked files', () => {
    expect(attachmentMarkdown('Folder/Note.md', 'attachments/1234abcd-a [b](c)#% ü.png')).toBe(
      '![a \\[b\\](c)#% ü.png](../attachments/1234abcd-a%20%5Bb%5D%28c%29%23%25%20%C3%BC.png)',
    );
  });

  it('rejects oversized/empty/unsupported images before reading or serializing bytes', async () => {
    const file = image();
    Object.defineProperty(file, 'size', { value: MAX_CLIPBOARD_IMAGE + 1 });
    const importer = vi.fn();
    await expect(importClipboardImages([file], target, () => true, importer)).rejects.toThrow(
      '10 MiB',
    );
    await expect(
      importClipboardImages(
        [new File([], 'empty.png', { type: 'image/png' })],
        target,
        () => true,
        importer,
      ),
    ).rejects.toThrow('non-empty');
    await expect(
      importClipboardImages(
        [new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' })],
        target,
        () => true,
        importer,
      ),
    ).rejects.toThrow('not supported');
    expect(importer).not.toHaveBeenCalled();
  });

  it('does not import if navigation happened while clipboard bytes were read', async () => {
    const file = image();
    let finish!: (bytes: ArrayBuffer) => void;
    Object.defineProperty(file, 'arrayBuffer', {
      value: () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve;
        }),
      configurable: true,
    });
    let current = true;
    const importer = vi.fn();
    const task = importClipboardImages([file], target, () => current, importer);
    current = false;
    finish(new Uint8Array([137]).buffer);
    expect(await task).toBeNull();
    expect(importer).not.toHaveBeenCalled();
  });

  it('does not return Markdown for insertion after navigation during native import', async () => {
    let finish!: (path: string) => void;
    const importer = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    let current = true;
    const task = importClipboardImages([image()], target, () => current, importer);
    await vi.waitFor(() => expect(importer).toHaveBeenCalled());
    current = false;
    finish('attachments/image.png');
    expect(await task).toBeNull();
  });
});

describe('Image paste editor integration', () => {
  it('preserves writing that replaces a pending image selection', async () => {
    let finish!: (markdown: string) => void;
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'before selected after',
        selection: { anchor: 7, head: 15 },
        extensions: [
          imagePasteExtension(
            () =>
              new Promise<string>((resolve) => {
                finish = resolve;
              }),
          ),
        ],
      }),
    });
    try {
      paste(view, clipboard(image()));
      view.dispatch({ changes: { from: 7, to: 15, insert: 'new writing' } });
      finish('![image](attachments/image.png)');
      await Promise.resolve();
      expect(view.state.doc.toString()).toBe('before new writing after');
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it('inserts at the selection, maps intervening typing, and supports one-step undo', async () => {
    let finish!: (markdown: string) => void;
    const importer = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: 'before selected after',
        selection: { anchor: 7, head: 15 },
        extensions: [history(), imagePasteExtension(importer)],
      }),
    });
    try {
      expect(paste(view, clipboard(image())).defaultPrevented).toBe(true);
      view.dispatch({ changes: { from: 0, insert: 'typed ' } });
      finish('![image](attachments/image.png)');
      await vi.waitFor(() =>
        expect(view.state.doc.toString()).toBe(
          'typed before ![image](attachments/image.png) after',
        ),
      );
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe('typed before selected after');
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it('does not intercept ordinary text or insert into an editor destroyed by navigation', async () => {
    let finish!: (markdown: string) => void;
    const importer = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: 'same note', extensions: [imagePasteExtension(importer)] }),
    });
    const plain = {
      items: [],
      files: [],
      getData: () => 'ordinary text',
    } as unknown as DataTransfer;
    paste(view, plain);
    expect(view.state.doc.toString()).toBe('ordinary textsame note');
    expect(importer).not.toHaveBeenCalled();
    paste(view, clipboard(image()));
    view.destroy();
    parent.remove();
    finish('![image](attachments/image.png)');
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe('ordinary textsame note');
  });
});
