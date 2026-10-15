import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { liveMarkdown } from '../src/liveMarkdown';

const fixture = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../src/api', () => ({ native: true, call: fixture.call }));
const createObjectURL = vi.fn(() => 'blob:live-image');
const revokeObjectURL = vi.fn();
let editor: EditorView | undefined;

beforeEach(() => {
  fixture.call.mockReset();
  fixture.call.mockResolvedValue({ bytes: [137, 80, 78, 71], mime_type: 'image/png' });
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
});
afterEach(() => {
  editor?.destroy();
  editor = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
function mount(doc: string) {
  editor = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), liveMarkdown('image-note')],
    }),
    parent: document.body,
  });
  return editor;
}

describe('Read image widgets retain correct resource ownership', () => {
  it('revokes the image URL after equal widgets reuse the same DOM', async () => {
    const view = mount('![Photo](attachments/photo.png)\n\nParagraph');
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const image = document.querySelector('img');
    view.dispatch({ changes: { from: view.state.doc.length, insert: ' edited' } });
    expect(document.querySelector('img')).toBe(image);
    view.destroy();
    editor = undefined;
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:live-image');
  });

  it('resolves reference images and refreshes them when the definition changes', async () => {
    const doc = '![Photo][photo]\n\n[photo]: attachments/first.png';
    const view = mount(doc);
    await waitFor(() =>
      expect(fixture.call).toHaveBeenCalledWith('attachment_bytes', {
        sourceNote: 'image-note',
        target: 'attachments/first.png',
      }),
    );
    const from = doc.indexOf('first.png');
    view.dispatch({ changes: { from, to: from + 'first.png'.length, insert: 'second.png' } });
    await waitFor(() =>
      expect(fixture.call).toHaveBeenCalledWith('attachment_bytes', {
        sourceNote: 'image-note',
        target: 'attachments/second.png',
      }),
    );
    expect(view.state.doc.toString()).toContain('![Photo][photo]');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:live-image');
  });

  it('normalizes an angle-wrapped link destination for navigation', () => {
    mount('[Site](<https://example.com/a%20b>)');
    expect(document.querySelector('a')?.dataset.liveTarget).toBe('https://example.com/a%20b');
    expect(document.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a%20b');
  });
});
