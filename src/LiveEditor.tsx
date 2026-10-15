import { useMemo, useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { redo, undo } from '@codemirror/commands';
import { EditorSelection, Prec, type EditorState } from '@codemirror/state';
import { EditorView, keymap, type Command } from '@codemirror/view';
import { Bold, Italic, Heading2, List, Link2, Undo2, Redo2, Code, Quote } from 'lucide-react';
import { call, native } from './api';
import { imagePasteExtension } from './image-paste-extension';
import { liveMarkdown, wrapSelection } from './liveMarkdown';

const wrap =
  (marker: string): Command =>
  (view) => {
    view.dispatch({ ...wrapSelection(view.state, marker), userEvent: 'input' });
    return true;
  };
export function prefixLines(state: EditorState, prefix: string) {
  const selection = state.selection.main;
  const first = state.doc.lineAt(selection.from);
  const last = state.doc.lineAt(
    selection.to > selection.from && state.doc.lineAt(selection.to).from === selection.to
      ? selection.to - 1
      : selection.to,
  );
  const lines = Array.from({ length: last.number - first.number + 1 }, (_, i) =>
    state.doc.line(first.number + i),
  );
  const remove = lines.every((line) => line.text.startsWith(prefix));
  return lines.map((line) => ({
    from: line.from,
    to:
      line.from +
      (remove
        ? prefix.length
        : prefix.startsWith('#')
          ? (/^#{1,6} /.exec(line.text)?.[0].length ?? 0)
          : 0),
    insert: remove ? '' : prefix,
  }));
}
const prefix =
  (text: string): Command =>
  (view) => {
    view.dispatch({ changes: prefixLines(view.state, text), userEvent: 'input' });
    return true;
  };
const insertLink: Command = (view) => {
  const { from, to } = view.state.selection.main;
  const label = view.state.sliceDoc(from, to) || 'link text';
  const start = from + label.length + 3;
  view.dispatch({
    changes: { from, to, insert: `[${label}](https://example.com)` },
    selection: EditorSelection.range(start, start + 'https://example.com'.length),
    userEvent: 'input',
  });
  return true;
};

export default function LiveEditor({
  noteId,
  value,
  dark,
  onChange,
  onLink,
  onPasteImageFiles,
}: {
  noteId: string;
  value: string;
  dark: boolean;
  onChange: (value: string) => void;
  onLink: (target: string, wiki: boolean) => void;
  onPasteImageFiles?: (files: File[]) => Promise<string | null>;
}) {
  const editor = useRef<EditorView | null>(null);
  const actions = useRef({ onLink, onPasteImageFiles });
  actions.current = { onLink, onPasteImageFiles };
  const canPaste = Boolean(onPasteImageFiles);
  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage }),
      EditorView.lineWrapping,
      liveMarkdown(noteId),
      Prec.high(
        keymap.of([
          { key: 'Mod-b', run: wrap('**') },
          { key: 'Mod-i', run: wrap('*') },
          { key: 'Mod-k', run: insertLink },
        ]),
      ),
      EditorView.domEventHandlers({
        click(event) {
          const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>(
            'a[data-live-target]',
          );
          if (!anchor) return false;
          event.preventDefault();
          if (!event.metaKey && !event.ctrlKey) return false;
          const target = anchor.dataset.liveTarget!;
          if (/^(https?:|mailto:)/i.test(target)) {
            if (native) void call('open_external', { url: target });
            else window.open(target, '_blank', 'noopener,noreferrer');
          } else if (!target.startsWith('#'))
            actions.current.onLink(target, anchor.dataset.liveWiki === 'true');
          return true;
        },
      }),
      ...(canPaste
        ? [
            imagePasteExtension(
              (files) => actions.current.onPasteImageFiles?.(files) ?? Promise.resolve(null),
            ),
          ]
        : []),
    ],
    [noteId, canPaste],
  ); // Callback identity must not reset an active editor or undo history.
  const run = (command: Command) => {
    if (editor.current) {
      command(editor.current);
      editor.current.focus();
    }
  };
  return (
    <div className="live-editor">
      <div className="live-toolbar" role="toolbar" aria-label="Markdown formatting">
        {(
          [
            ['Bold', Bold, wrap('**'), 'Ctrl/Cmd+B'],
            ['Italic', Italic, wrap('*'), 'Ctrl/Cmd+I'],
            ['Heading', Heading2, prefix('## '), ''],
            ['Bullet list', List, prefix('- '), ''],
            ['Quote', Quote, prefix('> '), ''],
            ['Inline code', Code, wrap('`'), ''],
            ['Link', Link2, insertLink, 'Ctrl/Cmd+K'],
            ['Undo', Undo2, undo, 'Ctrl/Cmd+Z'],
            ['Redo', Redo2, redo, 'Ctrl/Cmd+Shift+Z'],
          ] as const
        ).map(([label, Icon, command, shortcut]) => (
          <button
            type="button"
            key={label}
            aria-label={label}
            title={`${label}${shortcut ? ` (${shortcut})` : ''}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => run(command)}
          >
            <Icon size={15} />
          </button>
        ))}
        <span>Click to write · Ctrl/Cmd-click links to open</span>
      </div>
      <div className="reading-page live-reading-page">
        <CodeMirror
          value={value}
          extensions={extensions}
          theme={dark ? oneDark : 'light'}
          onChange={onChange}
          onCreateEditor={(view) => {
            editor.current = view;
          }}
          basicSetup={{
            lineNumbers: false,
            foldGutter: false,
            highlightActiveLine: false,
            highlightActiveLineGutter: false,
            autocompletion: false,
          }}
          height="100%"
          aria-label="Rendered Markdown editor"
        />
      </div>
    </div>
  );
}
