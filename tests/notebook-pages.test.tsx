import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import NotebookPages, { type NotebookPagesProps } from '../src/NotebookPages';
import { buildNotebookTree, pageNotebook } from '../src/notebook-tree';
import type { Note, VaultInfo } from '../src/types';

const page = (id: string, path: string, title = id): Note => ({
  id,
  path,
  title,
  content: '',
  hash: '',
  tags: [],
  modified: 1,
});
const rootPage = page('Root page', 'Root.md');
const nestedPage = page('Nested page', 'Work/Plans/Nested.md');
const literalPage = page('Literal page', 'Ideas%20/日本語/100%.md');
const info: VaultInfo = {
  root: '/private/tmp/notebook-component-test',
  name: 'My notes',
  folders: ['Work', 'Work/Plans', 'Empty', 'attachments', 'Work/attachments', 'Ideas%20/日本語'],
  notes: [rootPage, nestedPage, literalPage],
  status: { state: 'local', pending: 0, conflicts: 0, last_sync: null, message: null },
};
const props = (overrides: Partial<NotebookPagesProps> = {}): NotebookPagesProps => ({
  info,
  selectedId: null,
  selectedFolder: '',
  onSelectNotebook: vi.fn(),
  onSelectPage: vi.fn(),
  onNewNotebook: vi.fn(),
  onNewPage: vi.fn(),
  ...overrides,
});

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('notebook grouping', () => {
  it('keeps literal paths, infers missing ancestors, retains empty notebooks and excludes attachment folders', () => {
    const tree = buildNotebookTree(info);
    expect(tree.name).toBe('My notes');
    expect(tree.pages).toEqual([rootPage]);
    expect(tree.totalPages).toBe(3);
    expect(tree.notebooks.map((node) => node.name)).toEqual(['Empty', 'Ideas%20', 'Work']);
    expect(tree.notebooks[0].totalPages).toBe(0);
    expect(tree.notebooks[1].notebooks[0].pages).toEqual([literalPage]);
    expect(tree.notebooks[2].notebooks[0].pages).toEqual([nestedPage]);
    expect(pageNotebook(literalPage.path)).toBe('Ideas%20/日本語');
  });

  it('counts visible search pages separately from the full workspace', () => {
    const tree = buildNotebookTree(info, [nestedPage]);
    expect(tree.totalPages).toBe(3);
    expect(tree.visiblePages).toBe(1);
    expect(tree.pages).toEqual([]);
    expect(tree.notebooks.find((node) => node.name === 'Work')?.visiblePages).toBe(1);
  });
});

describe('notebook/page navigation', () => {
  it('expands nested notebooks using keyboard buttons and selects a page with its containing folder', async () => {
    const user = userEvent.setup();
    const callbacks = props();
    render(<NotebookPages {...callbacks} />);
    expect(screen.queryByRole('button', { name: 'Nested page' })).toBeNull();
    const work = screen.getByRole('button', { name: 'Expand notebook Work' });
    work.focus();
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'Expand notebook Plans' }));
    await user.click(screen.getByRole('button', { name: 'Nested page' }));
    expect(callbacks.onSelectPage).toHaveBeenCalledWith(nestedPage, 'Work/Plans');
    await user.click(screen.getByRole('button', { name: 'Collapse notebook Work' }));
    expect(screen.queryByRole('button', { name: 'Nested page' })).toBeNull();
  });

  it('opens selected page ancestors, allows collapsing them, and reveals a newly selected page', async () => {
    const user = userEvent.setup();
    const callbacks = props({ selectedId: nestedPage.id, selectedFolder: 'Work/Plans' });
    const { rerender } = render(<NotebookPages {...callbacks} />);
    expect(screen.getByRole('button', { name: 'Nested page' }).getAttribute('aria-current')).toBe(
      'page',
    );
    await user.click(screen.getByRole('button', { name: 'Collapse notebook Work' }));
    rerender(<NotebookPages {...callbacks} />);
    expect(screen.queryByRole('button', { name: 'Nested page' })).toBeNull();
    rerender(<NotebookPages {...callbacks} selectedId={literalPage.id} />);
    expect(screen.getByRole('button', { name: 'Literal page' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('selects empty notebooks and targets creation at the selected notebook', async () => {
    const user = userEvent.setup();
    const callbacks = props({ selectedFolder: 'Empty' });
    render(<NotebookPages {...callbacks} />);
    await user.click(screen.getByRole('button', { name: /^Empty/ }));
    expect(callbacks.onSelectNotebook).toHaveBeenCalledWith('Empty');
    expect(screen.getByText('No pages yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'New page' }));
    expect(callbacks.onNewPage).toHaveBeenCalledWith('Empty');
    await user.click(screen.getByRole('button', { name: 'New notebook' }));
    expect(callbacks.onNewNotebook).toHaveBeenCalledWith('');
  });

  it('reveals a newly created empty notebook and preserves a deliberate collapse on rerender', async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const { rerender } = render(<NotebookPages {...callbacks} />);
    const updatedInfo = { ...info, folders: [...info.folders, 'Work/New notebook'] };
    rerender(
      <NotebookPages {...callbacks} info={updatedInfo} selectedFolder="Work/New notebook" />,
    );
    expect(screen.getByRole('button', { name: 'Collapse notebook Work' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Collapse notebook New notebook' })).toBeTruthy();
    expect(screen.getByText('No pages yet.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Collapse notebook Work' }));
    rerender(
      <NotebookPages {...callbacks} info={updatedInfo} selectedFolder="Work/New notebook" />,
    );
    expect(screen.queryByRole('button', { name: 'Collapse notebook New notebook' })).toBeNull();
    expect(screen.getByRole('button', { name: 'New page' }).textContent).toBe('New page');
  });

  it('reveals the selected page after it moves to another notebook without changing its ID', async () => {
    const user = userEvent.setup();
    const callbacks = props({ selectedId: rootPage.id });
    const { rerender } = render(<NotebookPages {...callbacks} />);
    expect(screen.queryByRole('button', { name: 'Expand notebook Plans' })).toBeNull();
    const movedPage = { ...rootPage, path: 'Work/Plans/Renamed.md', title: 'Renamed page' };
    const updatedInfo = {
      ...info,
      notes: info.notes.map((note) => (note.id === rootPage.id ? movedPage : note)),
    };
    rerender(<NotebookPages {...callbacks} info={updatedInfo} selectedFolder="Work/Plans" />);
    expect(screen.getByRole('button', { name: 'Renamed page' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('button', { name: 'Collapse notebook Plans' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Collapse notebook Work' }));
    rerender(<NotebookPages {...callbacks} info={updatedInfo} selectedFolder="Work/Plans" />);
    expect(screen.queryByRole('button', { name: 'Renamed page' })).toBeNull();
  });

  it('reveals matching pages throughout notebooks during filtering and reports no matches', () => {
    const callbacks = props({ filterActive: true, filteredNotes: [nestedPage], query: 'nested' });
    const { rerender } = render(<NotebookPages {...callbacks} />);
    expect(screen.getByRole('button', { name: 'Nested page' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Root page' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Empty/ })).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('1 matching page for “nested”');
    rerender(<NotebookPages {...callbacks} filteredNotes={[]} />);
    expect(screen.getByText('No matching pages.')).toBeTruthy();
  });

  it('keeps expansion preferences separate for each workspace', async () => {
    const user = userEvent.setup();
    const callbacks = props();
    const { rerender } = render(<NotebookPages {...callbacks} />);
    await user.click(screen.getByRole('button', { name: 'Expand notebook Work' }));
    expect(screen.getByRole('button', { name: 'Expand notebook Plans' })).toBeTruthy();
    rerender(
      <NotebookPages {...callbacks} info={{ ...info, root: '/private/tmp/another-workspace' }} />,
    );
    expect(screen.queryByRole('button', { name: 'Expand notebook Plans' })).toBeNull();
    rerender(<NotebookPages {...callbacks} />);
    expect(screen.getByRole('button', { name: 'Expand notebook Plans' })).toBeTruthy();
  });
});
