import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type EditorState, type Extension, type Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { renderMarkdown } from './markdown';
import { hydrateLocalImages } from './localImages';

class ImageWidget extends WidgetType {
  private cleanup?: () => void;
  constructor(
    readonly source: string,
    readonly noteId: string,
  ) {
    super();
  }
  eq(other: ImageWidget) {
    return this.source === other.source && this.noteId === other.noteId;
  }
  toDOM() {
    const root = document.createElement('span');
    root.className = 'cm-live-image';
    root.title = 'Click to edit image Markdown';
    root.innerHTML = renderMarkdown(this.source);
    this.cleanup = hydrateLocalImages(root, this.noteId);
    return root;
  }
  destroy() {
    this.cleanup?.();
  }
  ignoreEvent() {
    return false;
  }
}
class BulletWidget extends WidgetType {
  toDOM() {
    const bullet = document.createElement('span');
    bullet.className = 'cm-live-bullet';
    bullet.textContent = '•';
    return bullet;
  }
}
class TaskWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
  ) {
    super();
  }
  eq(other: TaskWidget) {
    return this.checked === other.checked && this.from === other.from;
  }
  toDOM(view: EditorView) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    this.updateDOM(input);
    input.addEventListener('change', () => {
      view.dispatch({
        changes: {
          from: Number(input.dataset.from),
          to: Number(input.dataset.from) + 3,
          insert: input.checked ? '[x]' : '[ ]',
        },
        userEvent: 'input',
      });
    });
    return input;
  }
  updateDOM(dom: HTMLElement) {
    const input = dom as HTMLInputElement;
    input.checked = this.checked;
    input.dataset.from = String(this.from);
    input.setAttribute('aria-label', this.checked ? 'Mark task incomplete' : 'Mark task complete');
    return true;
  }
  ignoreEvent() {
    return true;
  }
}

// Decorations change only presentation. Never serialize rendered DOM back to Markdown:
// frontmatter and unsupported syntax must survive even a single-character edit unchanged.
export function liveDecorations(view: EditorView, noteId: string): DecorationSet {
  const state = view.state;
  const ranges: Range<Decoration>[] = [];
  const add = (from: number, to: number, decoration: Decoration) => {
    if (from < to) ranges.push(decoration.range(from, to));
  };
  const active = (from: number, to: number) =>
    view.hasFocus &&
    state.selection.ranges.some((selection) => selection.from <= to && selection.to >= from);
  const hide = (from: number, to: number) => add(from, to, Decoration.replace({}));
  const lineClasses = new Map<number, Set<string>>();
  const lineClass = (from: number, to: number, className: string) => {
    for (let position = state.doc.lineAt(from).from; position <= to;) {
      const line = state.doc.lineAt(position);
      const classes = lineClasses.get(line.from) ?? new Set<string>();
      classes.add(className);
      lineClasses.set(line.from, classes);
      if (line.to >= to || line.number === state.doc.lines) break;
      position = line.to + 1;
    }
  };
  const tree = syntaxTree(state);
  tree.iterate({
    enter(ref) {
      const { name, from, to, node } = ref;
      const text = state.sliceDoc(from, to);
      if (/^(FencedCode|CodeBlock|HTMLBlock|HTMLTag)$/.test(name)) {
        lineClass(from, to, 'cm-live-source-block');
        return false;
      }
      if (/^ATXHeading[1-6]$/.test(name)) lineClass(from, to, `cm-live-h${name.slice(-1)}`);
      if (/^SetextHeading[12]$/.test(name)) lineClass(from, to, `cm-live-h${name.slice(-1)}`);
      if (name === 'Blockquote') lineClass(from, to, 'cm-live-quote');
      if (name === 'StrongEmphasis') add(from, to, Decoration.mark({ class: 'cm-live-bold' }));
      if (name === 'Emphasis') add(from, to, Decoration.mark({ class: 'cm-live-italic' }));
      if (name === 'Strikethrough') add(from, to, Decoration.mark({ class: 'cm-live-strike' }));
      if (name === 'InlineCode') add(from, to, Decoration.mark({ class: 'cm-live-code' }));
      if (name === 'Image' && !text.includes('\n')) {
        if (!active(from, to))
          add(from, to, Decoration.replace({ widget: new ImageWidget(text, noteId) }));
        return false;
      }
      if (name === 'Link') {
        const url = node.getChild('URL');
        const first = node.firstChild;
        const labelEnd = first?.nextSibling;
        // Inline links only. Reference/complex Markdown remains editable source.
        const closing = node
          .getChildren('LinkMark')
          .find((mark) => state.sliceDoc(mark.from, mark.to) === ']');
        if (url && first && closing && labelEnd) {
          const target = state.sliceDoc(url.from, url.to);
          const attrs = linkAttributes(target, false);
          add(
            first.to,
            closing.from,
            Decoration.mark({ tagName: 'a', class: 'cm-live-link', attributes: attrs }),
          );
          if (!active(from, to)) {
            hide(from, first.to);
            hide(closing.from, to);
          }
        }
        return;
      }
      if (name === 'TaskMarker' && !active(from, to)) {
        add(from, to, Decoration.replace({ widget: new TaskWidget(/x/i.test(text), from) }));
        return false;
      }
      if (name === 'ListMark' && /^[-+*]$/.test(text) && !active(from, state.doc.lineAt(from).to)) {
        add(from, to, Decoration.replace({ widget: new BulletWidget() }));
      }
      if (/^(HeaderMark|EmphasisMark|CodeMark|StrikethroughMark|QuoteMark)$/.test(name)) {
        const parent = node.parent;
        if (parent && !active(parent.from, parent.to)) hide(from, to);
      }
    },
  });
  // Wiki links are an application extension to Markdown, outside Lezer's built-in grammar.
  const source = state.doc.toString();
  for (const match of source.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const from = match.index!;
    const to = from + match[0].length;
    let node = tree.resolveInner(from, 1);
    let literal = false;
    for (;;) {
      if (/Code|HTML|Image|Link/.test(node.name)) literal = true;
      if (!node.parent) break;
      node = node.parent;
    }
    if (literal) continue;
    const [target] = match[1].split('|');
    const separator = match[1].indexOf('|');
    const labelStart = from + 2 + (separator < 0 ? 0 : separator + 1);
    add(
      labelStart,
      to - 2,
      Decoration.mark({
        tagName: 'a',
        class: 'cm-live-link',
        attributes: linkAttributes(target, true),
      }),
    );
    if (!active(from, to)) {
      hide(from, labelStart);
      hide(to - 2, to);
    }
  }
  for (const [from, classes] of lineClasses)
    ranges.push(Decoration.line({ class: [...classes].join(' ') }).range(from));
  return Decoration.set(ranges, true);
}
function linkAttributes(target: string, wiki: boolean): Record<string, string> {
  return {
    href: /^(https?:|mailto:|#)/i.test(target) ? target : '#',
    'data-live-target': target,
    'data-live-wiki': String(wiki),
    title: 'Ctrl/Cmd-click to open; click to edit',
  };
}
export function liveMarkdown(noteId: string): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = liveDecorations(view, noteId);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.focusChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        )
          this.decorations = liveDecorations(update.view, noteId);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

export function wrapSelection(state: EditorState, marker: string, placeholder = 'text') {
  return state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    const adjacent =
      range.from >= marker.length &&
      state.sliceDoc(range.from - marker.length, range.from) === marker &&
      state.sliceDoc(range.to, range.to + marker.length) === marker;
    if (adjacent)
      return {
        changes: [
          { from: range.from - marker.length, to: range.from, insert: '' },
          { from: range.to, to: range.to + marker.length, insert: '' },
        ],
        range: EditorSelection.range(range.from - marker.length, range.to - marker.length),
      };
    const wrapped =
      selected.startsWith(marker) &&
      selected.endsWith(marker) &&
      selected.length > marker.length * 2;
    const insert = wrapped
      ? selected.slice(marker.length, -marker.length)
      : marker + (selected || placeholder) + marker;
    const from = range.from + (wrapped ? 0 : marker.length);
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.range(
        from,
        from + (wrapped ? insert.length : (selected || placeholder).length),
      ),
    };
  });
}
