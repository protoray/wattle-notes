import type { Note, VaultInfo } from './types';

export interface NotebookNode {
  path: string;
  name: string;
  notebooks: NotebookNode[];
  pages: Note[];
  totalPages: number;
  visiblePages: number;
}

/** Paths stay literal: a folder containing `%20` is not a folder containing a space. */
export function pageNotebook(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

export function notebookAncestors(path: string): string[] {
  const result = [''];
  const parts = path.split('/').filter(Boolean);
  for (let index = 1; index <= parts.length; index++) result.push(parts.slice(0, index).join('/'));
  return result;
}

function isAttachmentFolder(path: string) {
  return path.split('/').some((part) => part === 'attachments' || part === '.attachments');
}

export function buildNotebookTree(
  info: Pick<VaultInfo, 'name' | 'folders' | 'notes'>,
  visibleNotes: Note[] = info.notes,
): NotebookNode {
  const root: NotebookNode = {
    path: '',
    name: info.name,
    notebooks: [],
    pages: [],
    totalPages: 0,
    visiblePages: 0,
  };
  const nodes = new Map<string, NotebookNode>([['', root]]);
  const visibleIds = new Set(visibleNotes.map((note) => note.id));
  const ensureNotebook = (path: string): NotebookNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const notebook: NotebookNode = {
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      notebooks: [],
      pages: [],
      totalPages: 0,
      visiblePages: 0,
    };
    nodes.set(path, notebook);
    ensureNotebook(pageNotebook(path)).notebooks.push(notebook);
    return notebook;
  };
  for (const path of info.folders) {
    if (path && !isAttachmentFolder(path)) ensureNotebook(path);
  }
  for (const note of info.notes) {
    const path = pageNotebook(note.path);
    if (isAttachmentFolder(path)) continue;
    const notebook = ensureNotebook(path);
    if (visibleIds.has(note.id)) notebook.pages.push(note);
    for (const ancestor of notebookAncestors(path)) {
      const node = nodes.get(ancestor)!;
      node.totalPages++;
      if (visibleIds.has(note.id)) node.visiblePages++;
    }
  }
  for (const node of nodes.values()) {
    node.notebooks.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    node.pages.sort((a, b) => b.modified - a.modified || a.title.localeCompare(b.title));
  }
  return root;
}
