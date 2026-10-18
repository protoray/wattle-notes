import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Note, Revision } from '../src/types';

const fixture = vi.hoisted(() => ({
  note: null as Note | null,
  copies: [] as Note[],
  folders: [] as string[],
  resolved: false,
  versions: [] as Revision[],
  onClose: null as (() => void) | null,
  saveGate: null as Promise<void> | null,
  allowSave: false,
  exits: 0,
  folder: vi.fn(),
  currentRoot: 'test',
  openFailure: false,
  searchGate: null as Promise<Note[]> | null,
  searchStarted: vi.fn(),
  otherNote: null as Note | null,
  removedIds: [] as string[],
  deleteFolder: vi.fn(),
  syncGate: null as Promise<void> | null,
  syncStarted: vi.fn(),
  connected: false,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: fixture.folder }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_event: string, callback: () => void) => {
    fixture.onClose = callback;
    return () => {
      fixture.onClose = null;
    };
  },
}));
vi.mock('../src/api', () => ({
  native: true,
  call: async (command: string, args: Record<string, unknown> = {}) => {
    const note = fixture.note!;
    switch (command) {
      case 'last_vault':
        return 'test';
      case 'open_vault':
        if (args.root !== 'test' && fixture.openFailure)
          throw new Error('Selected folder is unavailable');
        fixture.currentRoot = String(args.root);
      // Falls through to return the newly selected notebook's data.
      case 'vault_info':
        return structuredClone({
          root: fixture.currentRoot,
          name: fixture.currentRoot === 'test' ? 'Notebook' : 'Other notebook',
          notes:
            fixture.currentRoot === 'test'
              ? [note, ...fixture.copies].filter((n) => !fixture.removedIds.includes(n.id))
              : [fixture.otherNote!],
          folders: fixture.folders,
          status: {
            state: 'conflict',
            pending: 0,
            conflicts: fixture.resolved ? 0 : 1,
            last_sync: null,
            message: null,
          },
        });
      case 'account_info':
        return {
          encrypted: false,
          unlocked: fixture.connected,
          connected: fixture.connected,
          bundled_client: false,
          settings: { client_id: '', client_secret: null },
        };
      case 'note_links':
        return { outbound: [], backlinks: [] };
      case 'sync_now':
        fixture.syncStarted();
        await fixture.syncGate;
        return { state: 'synced', pending: 0, conflicts: 0, last_sync: 1, message: null };
      case 'sync_progress':
        return null;
      case 'search_notes':
        fixture.searchStarted();
        return fixture.searchGate ?? [note];
      case 'history':
        return structuredClone(fixture.versions);
      case 'deleted_folders':
        return [];
      case 'delete_folder': {
        if (args.expectedRoot !== fixture.currentRoot)
          throw new Error(
            'The open workspace changed. Select the notebook again before deleting it.',
          );
        fixture.deleteFolder(String(args.path));
        const path = String(args.path);
        fixture.removedIds.push(
          ...[note, ...fixture.copies]
            .filter((n) => n.path.startsWith(`${path}/`))
            .map((n) => n.id),
        );
        fixture.folders = fixture.folders.filter(
          (folder) => folder !== path && !folder.startsWith(`${path}/`),
        );
        return;
      }
      case 'conflicts':
        return fixture.resolved
          ? []
          : [
              {
                item_id: note.id,
                path: note.path,
                reason: 'Overlapping edits',
                versions: structuredClone(fixture.versions),
              },
            ];
      case 'resolve_conflict':
        note.content = String(args.content);
        note.hash = 'resolved';
        fixture.resolved = true;
        return;
      case 'create_folder':
        fixture.folders.push(String(args.path));
        return;
      case 'create_note': {
        const copy: Note = {
          id: 'copy',
          path: String(args.path),
          title: String(args.path).split('/').pop()!.replace(/\.md$/, ''),
          content: '# Recovered draft\n',
          hash: 'new',
          tags: [],
          modified: 1,
        };
        fixture.copies.push(copy);
        return structuredClone(copy);
      }
      case 'save_note': {
        const copy = fixture.copies.find((n) => n.id === args.id);
        if (copy) {
          copy.content = String(args.content);
          copy.hash = 'saved';
          return structuredClone(copy);
        }
        if (fixture.allowSave) {
          await fixture.saveGate;
          note.content = String(args.content);
          note.hash = 'saved';
          return structuredClone(note);
        }
        throw new Error('Resolve the conflict first');
      }
      case 'finish_exit':
        fixture.exits += 1;
        return;
      default:
        throw new Error(`Unexpected test command: ${command}`);
    }
  },
}));
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <textarea
      aria-label="Markdown editor"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
import App from '../src/App';

beforeEach(() => {
  fixture.note = {
    id: 'note',
    path: 'Idea.md',
    title: 'Idea',
    content: '# Idea\n\nBase note.\n',
    hash: 'base',
    tags: [],
    modified: 1,
  };
  fixture.copies = [];
  fixture.removedIds = [];
  fixture.deleteFolder.mockReset();
  fixture.syncGate = null;
  fixture.syncStarted.mockReset();
  fixture.connected = false;
  fixture.folders = [];
  localStorage.clear();
  fixture.resolved = false;
  fixture.onClose = null;
  fixture.saveGate = null;
  fixture.allowSave = false;
  fixture.exits = 0;
  fixture.folder.mockReset();
  fixture.folder.mockResolvedValue('other');
  fixture.currentRoot = 'test';
  fixture.openFailure = false;
  fixture.searchGate = null;
  fixture.searchStarted.mockReset();
  fixture.otherNote = {
    ...fixture.note,
    id: 'other-note',
    path: 'Other.md',
    title: 'Other',
    content: '# Other\n\nAnother notebook.\n',
    hash: 'other',
  };
  fixture.versions = ['# Idea\n\nSaved draft.\n', '# Idea\n\nOther note.\n'].map((content, i) => ({
    id: `version-${i}`,
    item_id: 'note',
    parents: [],
    path: 'Idea.md',
    kind: 'note',
    deleted: false,
    content,
    blob_id: null,
    dependencies: [],
  }));
});

describe('Closing waits for the editor save', () => {
  it('flushes pending text before allowing the native application to exit', async () => {
    fixture.allowSave = true;
    let release!: () => void;
    fixture.saveGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(<App />);
    const editor = await screen.findByLabelText('Markdown editor');
    await waitFor(() => expect(fixture.onClose).not.toBeNull());
    fireEvent.change(editor, { target: { value: '# Idea\n\nSave me before quitting.' } });
    act(() => fixture.onClose!());
    expect(fixture.exits).toBe(0);
    await act(async () => {
      release();
      await fixture.saveGate;
    });
    await waitFor(() => expect(fixture.exits).toBe(1));
    expect(fixture.note!.content).toBe('# Idea\n\nSave me before quitting.');
  });
  it('keeps the app open and reports a failed save', async () => {
    render(<App />);
    const editor = await screen.findByLabelText('Markdown editor');
    await waitFor(() => expect(fixture.onClose).not.toBeNull());
    fireEvent.change(editor, { target: { value: '# Idea\n\nUnsaved text.' } });
    act(() => fixture.onClose!());
    await screen.findByText(/Save before closing:.*Resolve the conflict first/);
    expect(fixture.exits).toBe(0);
    expect((editor as HTMLTextAreaElement).value).toContain('Unsaved text.');
  });
});
afterEach(() => cleanup());

describe('Selecting another notebook', () => {
  it('clears the old search and ignores a late result from the previous notebook', async () => {
    let completeSearch!: (notes: Note[]) => void;
    fixture.searchGate = new Promise<Note[]>((resolve) => {
      completeSearch = resolve;
    });
    render(<App />);
    await screen.findByLabelText('Markdown editor');
    const search = screen.getByRole('textbox', { name: 'Search pages' });
    fireEvent.change(search, { target: { value: 'Base note' } });
    await waitFor(() => expect(fixture.searchStarted).toHaveBeenCalledOnce());
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /Notebook Workspace folder/ }));
    await waitFor(() =>
      expect((screen.getByLabelText('Markdown editor') as HTMLTextAreaElement).value).toBe(
        '# Other\n\nAnother notebook.\n',
      ),
    );
    expect((search as HTMLInputElement).value).toBe('');
    await act(async () => {
      completeSearch([fixture.note!]);
      await fixture.searchGate;
    });
    const sidebar = within(screen.getByRole('complementary'));
    expect(sidebar.queryByRole('button', { name: /^Idea/ })).toBeNull();
    expect(sidebar.getByRole('button', { name: 'Other' })).toBeDefined();
  });
  it('retains the current editor and saves pending text when the replacement cannot open', async () => {
    fixture.allowSave = true;
    fixture.openFailure = true;
    render(<App />);
    const editor = await screen.findByLabelText('Markdown editor');
    fireEvent.change(editor, { target: { value: '# Idea\n\nKeep my latest writing.' } });
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /Notebook Workspace folder/ }));
    await screen.findByText('Error: Selected folder is unavailable');
    expect(fixture.currentRoot).toBe('test');
    expect(fixture.note!.content).toBe('# Idea\n\nKeep my latest writing.');
    expect((editor as HTMLTextAreaElement).value).toBe(fixture.note!.content);
    fireEvent.change(editor, { target: { value: '# Idea\n\nI can keep writing.' } });
    await act(async () => {
      fixture.onClose!();
    });
    await waitFor(() => expect(fixture.exits).toBe(1));
    expect(fixture.note!.content).toBe('# Idea\n\nI can keep writing.');
  });
});

describe('Conflict resolution returns to the current editor safely', () => {
  async function resolveWithDraft(draft: string) {
    const user = userEvent.setup();
    render(<App />);
    const editor = await screen.findByLabelText('Markdown editor');
    await user.clear(editor);
    await user.type(editor, draft);
    await user.click(screen.getByRole('button', { name: /conflict needs your review/ }));
    await user.click(await screen.findByRole('button', { name: 'Version 2' }));
    await user.click(screen.getByRole('button', { name: 'Save resolution' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Markdown editor') as HTMLTextAreaElement).value).toBe(
        '# Idea\n\nOther note.\n',
      ),
    );
  }
  it('displays the selected resolution instead of the old unsaved editor draft', async () => {
    await resolveWithDraft('# Idea\n\nSaved draft.\n');
    expect(fixture.copies).toHaveLength(0);
  });
  it('preserves newer text that was never captured in conflict history', async () => {
    const draft = '# Idea\n\nA newer unsaved idea.\n';
    await resolveWithDraft(draft);
    expect(fixture.copies).toHaveLength(1);
    expect(fixture.copies[0].content).toBe(draft);
    expect(fixture.copies[0].path).toContain('recovered draft');
  });
});

describe('Notebook and page creation', () => {
  it('queues deletion during sync and gives it priority over another automatic sync', async () => {
    fixture.connected = true;
    fixture.resolved = true;
    fixture.allowSave = true;
    fixture.note!.path = 'Work/Idea.md';
    fixture.folders = ['Work'];
    let finishSync!: () => void;
    let finishSave!: () => void;
    fixture.syncGate = new Promise<void>((resolve) => {
      finishSync = resolve;
    });
    const user = userEvent.setup();
    render(<App />);
    const editor = await screen.findByLabelText('Markdown editor');
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(fixture.syncStarted).toHaveBeenCalledTimes(1));
    fireEvent.change(editor, { target: { value: '# Idea\n\nSaved after waiting for sync.' } });
    fixture.saveGate = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    await user.click(screen.getByRole('button', { name: 'Delete notebook Work' }));
    await user.click(screen.getByRole('button', { name: 'Delete after sync' }));
    const confirm = screen.getByRole('dialog', { name: 'Delete this notebook?' });
    expect(within(confirm).getByRole('status').textContent).toContain(
      'Waiting for the current sync',
    );
    expect(fixture.deleteFolder).not.toHaveBeenCalled();
    // Replace a cancelled wait while the same pass is still active. The older
    // continuation must not clear the newer request's busy/priority state.
    await user.click(within(confirm).getByRole('button', { name: 'Keep notebook' }));
    await user.click(screen.getByRole('button', { name: 'Delete notebook Work' }));
    await user.click(screen.getByRole('button', { name: 'Delete after sync' }));
    const replacement = screen.getByRole('dialog', { name: 'Delete this notebook?' });
    await act(async () => {
      finishSync();
    });
    await waitFor(() =>
      expect(within(replacement).getByRole('button', { name: 'Deleting…' })).toBeTruthy(),
    );
    // The sync pass has ended, but saving before deletion is still pending.
    // An online event must not steal the idle slot and block deletion again.
    fireEvent(window, new Event('online'));
    expect(fixture.syncStarted).toHaveBeenCalledTimes(1);
    expect(fixture.deleteFolder).not.toHaveBeenCalled();
    await act(async () => {
      finishSave();
    });
    await waitFor(() => expect(fixture.deleteFolder).toHaveBeenCalledWith('Work'));
    expect(fixture.note!.content).toContain('Saved after waiting for sync.');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('can finish a confirmed local deletion after the active sync fails', async () => {
    fixture.connected = true;
    fixture.resolved = true;
    fixture.note!.path = 'Work/Idea.md';
    fixture.folders = ['Work'];
    let failSync!: (error: Error) => void;
    fixture.syncGate = new Promise<void>((_resolve, reject) => {
      failSync = reject;
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText('Markdown editor');
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    await user.click(screen.getByRole('button', { name: 'Delete notebook Work' }));
    await user.click(screen.getByRole('button', { name: 'Delete after sync' }));
    await act(async () => {
      failSync(new Error('Drive request timed out'));
    });
    await waitFor(() => expect(fixture.deleteFolder).toHaveBeenCalledWith('Work'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it.each(['Keep notebook', 'Close dialog', 'Escape'])(
    'cancels a queued deletion using %s without deleting when sync finishes',
    async (cancel) => {
      fixture.connected = true;
      fixture.resolved = true;
      fixture.note!.path = 'Work/Idea.md';
      fixture.folders = ['Work'];
      let finishSync!: () => void;
      fixture.syncGate = new Promise<void>((resolve) => {
        finishSync = resolve;
      });
      const user = userEvent.setup();
      render(<App />);
      await screen.findByLabelText('Markdown editor');
      await user.click(await screen.findByRole('button', { name: 'Sync now' }));
      await waitFor(() => expect(fixture.syncStarted).toHaveBeenCalled());
      await user.click(screen.getByRole('button', { name: 'Delete notebook Work' }));
      await user.click(screen.getByRole('button', { name: 'Delete after sync' }));
      if (cancel === 'Escape') await user.keyboard('{Escape}');
      else await user.click(screen.getByRole('button', { name: cancel }));
      expect(screen.queryByRole('dialog')).toBeNull();
      await act(async () => {
        finishSync();
      });
      expect(fixture.deleteFolder).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Markdown editor')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Delete notebook Work' })).toBeTruthy();
    },
  );
  it('does not delete a same-named notebook if the workspace changes while waiting', async () => {
    fixture.connected = true;
    fixture.resolved = true;
    fixture.note!.path = 'Work/Idea.md';
    fixture.folders = ['Work'];
    let finishSync!: () => void;
    fixture.syncGate = new Promise<void>((resolve) => {
      finishSync = resolve;
    });
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText('Markdown editor');
    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    await user.click(screen.getByRole('button', { name: 'Delete notebook Work' }));
    await user.click(screen.getByRole('button', { name: 'Delete after sync' }));
    fixture.currentRoot = 'other';
    await act(async () => {
      finishSync();
    });
    expect((await screen.findByRole('alert')).textContent).toContain('workspace changed');
    expect(fixture.deleteFolder).not.toHaveBeenCalled();
  });
  it('confirms notebook deletion, saves pending text, and keeps neighbouring notebooks', async () => {
    fixture.allowSave = true;
    fixture.resolved = true;
    fixture.note!.path = 'Work/Idea.md';
    fixture.folders = ['Work', 'Work/Nested', 'Workshop'];
    fixture.copies = [{ ...fixture.otherNote!, path: 'Workshop/Other.md' }];
    const user = userEvent.setup();
    render(<App />);
    const editor = await screen.findByLabelText('Markdown editor');
    await user.click(screen.getByRole('button', { name: 'Delete notebook Work' }));
    await user.click(screen.getByRole('button', { name: 'Keep notebook' }));
    expect(fixture.deleteFolder).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: '# Idea\n\nLatest text before deletion.' } });
    await user.click(screen.getByRole('button', { name: 'Delete notebook Work' }));
    await user.click(screen.getByRole('button', { name: 'Delete notebook' }));
    await waitFor(() => expect(fixture.deleteFolder).toHaveBeenCalledWith('Work'));
    expect(fixture.note!.content).toContain('Latest text before deletion.');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Expand notebook Work' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Collapse notebook Work' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Expand notebook Workshop' })).toBeTruthy();
    expect(screen.queryByLabelText('Markdown editor')).toBeNull();
  });
  it('retains the notebook and pending draft when saving before deletion fails', async () => {
    fixture.note!.path = 'Work/Idea.md';
    fixture.folders = ['Work'];
    const user = userEvent.setup();
    render(<App />);
    const editor = await screen.findByLabelText('Markdown editor');
    fireEvent.change(editor, { target: { value: '# Idea\n\nKeep this unsaved draft.' } });
    await user.click(screen.getByRole('button', { name: 'Delete notebook Work' }));
    await user.click(screen.getByRole('button', { name: 'Delete notebook' }));
    await screen.findByText('Error: Resolve the conflict first');
    expect(fixture.deleteFolder).not.toHaveBeenCalled();
    expect((editor as HTMLTextAreaElement).value).toContain('Keep this unsaved draft.');
    expect(screen.getByRole('dialog', { name: 'Delete this notebook?' })).toBeTruthy();
  });
  it('keeps a new empty notebook selected and creates its page in that folder', async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByLabelText('Markdown editor');
    await user.click(screen.getByRole('button', { name: 'New notebook' }));
    await user.type(screen.getByRole('textbox', { name: 'Notebook name' }), 'Work');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('No pages yet.');
    expect(screen.queryByLabelText('Markdown editor')).toBeNull();
    expect(screen.getByRole('button', { name: 'Collapse notebook Work' })).toBeDefined();
    const navigation = within(screen.getByRole('region', { name: 'Notebooks and pages' }));
    await user.click(navigation.getByRole('button', { name: 'New page' }));
    await screen.findByText('Saved in Work as Markdown.');
    await user.type(screen.getByRole('textbox', { name: 'Page name' }), 'Plans');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByRole('heading', { name: 'Plans' });
    expect(fixture.copies[0].path).toBe('Work/Plans.md');
    expect(navigation.getByRole('button', { name: 'Plans' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });
  it('retains the current page and creation notebook when saving before a page switch fails', async () => {
    fixture.note!.path = 'Work/Idea.md';
    fixture.folders = ['Work', 'Other'];
    fixture.copies = [{ ...fixture.otherNote!, path: 'Other/Other.md' }];
    const user = userEvent.setup();
    render(<App />);
    const editor = await screen.findByLabelText('Markdown editor');
    await user.click(screen.getByRole('button', { name: 'Expand notebook Other' }));
    fireEvent.change(editor, { target: { value: '# Idea\n\nUnsaved changes.' } });
    await user.click(screen.getByRole('button', { name: 'Other' }));
    await screen.findByText('Error: Resolve the conflict first');
    expect((editor as HTMLTextAreaElement).value).toContain('Unsaved changes.');
    expect(screen.getByRole('button', { name: 'Idea' }).getAttribute('aria-current')).toBe('page');
    await user.click(screen.getByRole('button', { name: 'New page' }));
    await screen.findByText('Saved in Work as Markdown.');
  });
});
