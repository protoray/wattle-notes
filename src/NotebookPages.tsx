import { useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, ChevronRight, FilePlus2, FileText, FolderPlus, Trash2 } from 'lucide-react';
import type { Note, VaultInfo } from './types';
import {
  buildNotebookTree,
  notebookAncestors,
  pageNotebook,
  type NotebookNode,
} from './notebook-tree';
import './notebook-pages.css';

export interface NotebookPagesProps {
  info: VaultInfo;
  selectedId: string | null;
  selectedFolder: string;
  /** Search/tag results across the whole workspace, before any notebook filter. */
  filteredNotes?: Note[];
  filterActive?: boolean;
  query?: string;
  onSelectNotebook: (path: string) => void;
  onSelectPage: (note: Note, folder: string) => void;
  onNewNotebook: (parentPath: string) => void;
  onNewPage: (folderPath: string) => void;
  onDeleteNotebook: (path: string) => void;
  syncing?: boolean;
}

function readExpansion(key: string, selectedPath: string | null) {
  let saved: string[] = [''];
  try {
    const raw = localStorage.getItem(key);
    const value: unknown = raw === null ? [''] : JSON.parse(raw);
    if (Array.isArray(value))
      saved = value.filter((path): path is string => typeof path === 'string');
  } catch {
    /* Storage can be unavailable in private browser windows. */
  }
  return new Set([...saved, ...(selectedPath === null ? [] : notebookAncestors(selectedPath))]);
}

/** Reset expansion ownership when a different Markdown workspace is opened. */
export default function NotebookPages(props: NotebookPagesProps) {
  return <NotebookPagesWorkspace key={props.info.root} {...props} />;
}

function NotebookPagesWorkspace({
  info,
  selectedId,
  selectedFolder,
  filteredNotes,
  filterActive = false,
  query = '',
  onSelectNotebook,
  onSelectPage,
  onNewNotebook,
  onNewPage,
  onDeleteNotebook,
  syncing = false,
}: NotebookPagesProps) {
  const tree = useMemo(() => buildNotebookTree(info, filteredNotes), [info, filteredNotes]);
  const storageKey = `wattle-notes:notebook-expansion:${info.root}`;
  const selectedPath = pageNotebook(info.notes.find((note) => note.id === selectedId)?.path || '');
  const selectedPageRef = useRef<HTMLButtonElement>(null);
  const [expansion, setExpansion] = useState(() => ({
    selectedId,
    selectedPath,
    selectedFolder,
    paths: readExpansion(storageKey, selectedId ? selectedPath : selectedFolder || null),
  }));
  // A newly selected page or notebook must be reachable, including after a search.
  // Render-time adjustment avoids briefly painting it inside a collapsed ancestor.
  if (
    expansion.selectedId !== selectedId ||
    expansion.selectedPath !== selectedPath ||
    expansion.selectedFolder !== selectedFolder
  ) {
    const revealPath = selectedId === null ? selectedFolder : selectedPath;
    const shouldReveal =
      expansion.selectedId !== selectedId ||
      expansion.selectedPath !== selectedPath ||
      selectedId === null;
    setExpansion({
      selectedId,
      selectedPath,
      selectedFolder,
      paths: shouldReveal
        ? new Set([...expansion.paths, ...notebookAncestors(revealPath)])
        : expansion.paths,
    });
  }
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify([...expansion.paths]));
    } catch {
      /* Navigation still works when preference storage is unavailable. */
    }
  }, [storageKey, expansion.paths]);
  useEffect(() => {
    selectedPageRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selectedId, filterActive]);

  const toggle = (path: string) =>
    setExpansion((current) => {
      const paths = new Set(current.paths);
      if (paths.has(path)) paths.delete(path);
      else paths.add(path);
      return { ...current, paths };
    });

  const renderNotebook = (node: NotebookNode): React.ReactNode => {
    if (filterActive && !node.visiblePages && node.path !== '') return null;
    const open = filterActive ? node.visiblePages > 0 : expansion.paths.has(node.path);
    const count = filterActive ? node.visiblePages : node.totalPages;
    const countLabel = `${count} ${count === 1 ? 'page' : 'pages'}${filterActive ? ' matching the filter' : ''} in this notebook and its subnotebooks`;
    return (
      <li className="notebook-node" key={node.path}>
        <div className={`notebook-row ${selectedFolder === node.path ? 'active' : ''}`}>
          <button
            className="notebook-toggle"
            type="button"
            aria-label={`${open ? 'Collapse' : 'Expand'} notebook ${node.name}`}
            aria-expanded={open}
            onClick={() => toggle(node.path)}
            disabled={filterActive}
            title={filterActive ? 'Matching notebooks are expanded while filtering' : undefined}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
          <button
            className="notebook-name"
            type="button"
            aria-pressed={selectedFolder === node.path}
            onClick={() => {
              setExpansion((current) => ({
                ...current,
                paths: new Set([...current.paths, ...notebookAncestors(node.path)]),
              }));
              onSelectNotebook(node.path);
            }}
            title={node.path || info.name}
          >
            <BookOpen size={16} aria-hidden="true" />
            <span>{node.name}</span>
            <small aria-label={countLabel}>{count}</small>
          </button>
          {node.path && (
            <button
              className="notebook-delete"
              type="button"
              aria-label={`Delete notebook ${node.path}`}
              title={
                syncing ? 'Delete notebook after the current sync finishes' : 'Delete notebook'
              }
              onClick={() => onDeleteNotebook(node.path)}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        {open && (
          <ul className="notebook-children">
            {node.notebooks.map(renderNotebook)}
            {node.pages.map((note) => (
              <li key={note.id} className="notebook-page">
                <button
                  ref={note.id === selectedId ? selectedPageRef : undefined}
                  type="button"
                  className={`notebook-page-button note-card ${note.id === selectedId ? 'selected' : ''}`}
                  aria-current={note.id === selectedId ? 'page' : undefined}
                  title={note.path}
                  onClick={() => onSelectPage(note, node.path)}
                >
                  <FileText size={15} aria-hidden="true" />
                  <span>{note.title || 'Untitled page'}</span>
                </button>
              </li>
            ))}
            {!node.notebooks.length && !node.pages.length && (
              <li className="notebook-empty">No pages yet.</li>
            )}
          </ul>
        )}
      </li>
    );
  };

  return (
    <section className="notebook-pages" aria-label="Notebooks and pages">
      <div className="notebook-pages-heading">
        <h2>Notebooks</h2>
        <div className="notebook-create-actions">
          <button
            className="icon-button"
            aria-label="New notebook"
            title="New notebook"
            onClick={() => onNewNotebook('')}
          >
            <FolderPlus size={17} />
          </button>
          <button
            className="notebook-new-page"
            aria-label="New page"
            title="New page in the selected notebook"
            onClick={() => onNewPage(selectedFolder)}
          >
            <FilePlus2 size={17} />
            <span>New page</span>
          </button>
        </div>
      </div>
      {filterActive && (
        <p className="notebook-filter-caption" role="status">
          {tree.visiblePages} matching {tree.visiblePages === 1 ? 'page' : 'pages'}
          {query.trim() ? ` for “${query.trim()}”` : ''}
        </p>
      )}
      <nav aria-label="Notebook pages">
        <ul className="notebook-tree">{renderNotebook(tree)}</ul>
      </nav>
      {filterActive && !tree.visiblePages && (
        <p className="notebook-no-matches">No matching pages.</p>
      )}
    </section>
  );
}
