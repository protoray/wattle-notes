import { Transaction } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { clipboardImageFiles } from './clipboard-images';

export type PasteImageFiles = (files: File[]) => Promise<string | null>;

export function imagePasteExtension(
  importImages: PasteImageFiles,
  onError: (error: unknown) => void = () => {},
) {
  return ViewPlugin.fromClass(
    class {
      alive = true;
      pending = new Set<{ from: number; to: number; canceled: boolean }>();
      constructor(readonly view: EditorView) {}
      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        for (const range of this.pending) {
          // If the user rewrites the selected text while an import is pending,
          // preserve that writing instead of replacing it with the late image.
          update.changes.iterChangedRanges((from, to) => {
            if (range.from < range.to && from < range.to && to > range.from) range.canceled = true;
          });
          range.from = update.changes.mapPos(range.from, 1);
          range.to = Math.max(range.from, update.changes.mapPos(range.to, -1));
        }
      }
      destroy() {
        this.alive = false;
        this.pending.clear();
      }
      paste(event: ClipboardEvent): boolean {
        const files = clipboardImageFiles(event.clipboardData);
        if (!files.length) return false;
        event.preventDefault();
        const { from, to } = this.view.state.selection.main;
        const range = { from, to, canceled: false };
        this.pending.add(range);
        void importImages(files)
          .then((markdown) => {
            if (!this.alive || range.canceled || !markdown) return;
            this.pending.delete(range);
            this.view.dispatch({
              changes: { from: range.from, to: range.to, insert: markdown },
              selection: { anchor: range.from + markdown.length },
              annotations: Transaction.userEvent.of('input.paste'),
            });
          })
          .catch(onError)
          .finally(() => this.pending.delete(range));
        return true;
      }
    },
    {
      eventHandlers: {
        paste(event) {
          return this.paste(event);
        },
      },
    },
  );
}
