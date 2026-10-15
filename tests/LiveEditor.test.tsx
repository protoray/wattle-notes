import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import LiveEditor from '../src/LiveEditor';

afterEach(cleanup);
function currentEditor(container: HTMLElement) {
  return EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!;
}
function pasteImage(view: EditorView) {
  const file = new File(['png'], 'image.png', { type: 'image/png' });
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
      files: [file],
    },
  });
  view.contentDOM.dispatchEvent(event);
  return event;
}
const baseProps = { noteId: 'note', dark: false, onLink: () => {} };

describe('Persistent editor view transitions', () => {
  it('keeps the same editor and undo history when switching Read, Write and Split presentation', async () => {
    const changed = vi.fn();
    const props = { ...baseProps, value: '# Heading\n\nhello', onChange: changed };
    const { container, rerender } = render(<LiveEditor {...props} rendered />);
    const original = currentEditor(container);
    act(() =>
      original.dispatch({
        changes: { from: original.state.doc.length, insert: ' from Read' },
        userEvent: 'input',
      }),
    );
    rerender(<LiveEditor {...props} rendered={false} />);
    expect(currentEditor(container)).toBe(original);
    expect(container.querySelector('.reading-page')).toBeNull();
    act(() => {
      expect(undo(original)).toBe(true);
    });
    expect(original.state.doc.toString()).toBe(props.value);
    rerender(<LiveEditor {...props} rendered />);
    expect(currentEditor(container)).toBe(original);
    expect(container.querySelector('.reading-page')).not.toBeNull();
    expect(changed).toHaveBeenLastCalledWith(props.value);
  });

  it('finishes a pending image paste at its mapped selection after changing presentation', async () => {
    let finish!: (markdown: string) => void;
    const importer = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const props = {
      ...baseProps,
      value: 'before selected after',
      onChange: vi.fn(),
      onPasteImageFiles: importer,
    };
    const { container, rerender } = render(<LiveEditor {...props} rendered={false} />);
    const original = currentEditor(container);
    act(() => {
      original.dispatch({ selection: { anchor: 7, head: 15 } });
      expect(pasteImage(original).defaultPrevented).toBe(true);
    });
    expect(importer).toHaveBeenCalledOnce();
    rerender(<LiveEditor {...props} rendered />);
    act(() => original.dispatch({ changes: { from: 0, insert: 'typed ' }, userEvent: 'input' }));
    rerender(<LiveEditor {...props} rendered={false} />);
    await act(async () => {
      finish('![image](attachments/image.png)');
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(original.state.doc.toString()).toBe(
        'typed before ![image](attachments/image.png) after',
      ),
    );
    expect(currentEditor(container)).toBe(original);
    act(() => {
      expect(undo(original)).toBe(true);
    });
    expect(original.state.doc.toString()).toBe('typed before selected after');
  });
});
