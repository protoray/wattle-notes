import { describe, expect, it } from 'vitest';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { undo, history } from '@codemirror/commands';
import { liveDecorations, wrapSelection } from '../src/liveMarkdown';
import { prefixLines } from '../src/LiveEditor';

function state(doc: string, from = 0, to = from) {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(from, to),
    extensions: [markdown({ base: markdownLanguage })],
  });
}
describe('Markdown live editing preserves the source', () => {
  it('wraps and unwraps selected text while preserving the rest of the Markdown exactly', () => {
    const content =
      '# Head\n\nKeep _this_ and [[wiki|label]].\n\n```md\n**literal**\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<div>raw</div>\n';
    const from = content.indexOf('Keep');
    const first = state(content, from, from + 4);
    const bold = first.update(wrapSelection(first, '**')).state;
    expect(bold.doc.toString()).toBe(content.replace('Keep', '**Keep**'));
    expect(bold.sliceDoc(bold.selection.main.from, bold.selection.main.to)).toBe('Keep');
    expect(bold.update(wrapSelection(bold, '**')).state.doc.toString()).toBe(content);
  });
  it('styles headings, emphasis, links, tasks and images without rewriting any bytes', () => {
    const content =
      '# Head\n\n**Bold** and *italic*\n\n- [ ] task\n\n[[a|Alias]] and [web](https://example.com)\n\n![pic](attachments/my%20pic.png)';
    const view = new EditorView({ state: state(content), parent: document.body });
    const decorations = liveDecorations(view, 'note-1');
    const values: { from: number; to: number; spec: Record<string, unknown> }[] = [];
    decorations.between(0, content.length, (from, to, value) => {
      values.push({ from, to, spec: value.spec });
    });
    expect(values.some((v) => v.spec.class === 'cm-live-h1')).toBe(true);
    expect(values.some((v) => v.spec.class === 'cm-live-bold')).toBe(true);
    expect(values.some((v) => v.spec.tagName === 'a')).toBe(true);
    expect(values.filter((v) => v.spec.widget)).toHaveLength(3);
    expect(view.state.doc.toString()).toBe(content);
    view.destroy();
  });
  it('keeps code and HTML literal, including wiki syntax inside them', () => {
    const content =
      '```md\n[[literal]]\n**literal**\n```\n\n<div>[[literal]]</div>\n\n`[[inline]]`';
    const view = new EditorView({ state: state(content), parent: document.body });
    const decorations = liveDecorations(view, 'note-1');
    let links = 0;
    decorations.between(0, content.length, (_from, _to, value) => {
      if (value.spec.tagName === 'a') links++;
    });
    expect(links).toBe(0);
    expect(view.state.doc.toString()).toBe(content);
    view.destroy();
  });
  it('formats whole selected lines, excluding a following line selected only at its start', () => {
    const first = state('first\nsecond\nthird', 0, 13);
    const updated = first.update({ changes: prefixLines(first, '- ') }).state;
    expect(updated.doc.toString()).toBe('- first\n- second\nthird');
    const selected = updated.update({ selection: EditorSelection.single(0, 17) }).state;
    expect(selected.update({ changes: prefixLines(selected, '- ') }).state.doc.toString()).toBe(
      'first\nsecond\nthird',
    );
  });
  it('uses normal CodeMirror undo for a formatting transaction', () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: 'hello',
        selection: EditorSelection.single(0, 5),
        extensions: [history()],
      }),
      parent: document.body,
    });
    view.dispatch({ ...wrapSelection(view.state, '**'), userEvent: 'input' });
    expect(view.state.doc.toString()).toBe('**hello**');
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('hello');
    view.destroy();
  });
});
