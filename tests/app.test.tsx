import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Note, Revision } from '../src/types';

const fixture = vi.hoisted(() => ({
  note: null as Note | null,
  copies: [] as Note[],
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
          notes: fixture.currentRoot === 'test' ? [note, ...fixture.copies] : [fixture.otherNote!],
          folders: [],
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
          unlocked: false,
          connected: false,
          bundled_client: false,
          settings: { client_id: '', client_secret: null },
        };
      case 'note_links':
        return { outbound: [], backlinks: [] };
      case 'search_notes':
        fixture.searchStarted();
        return fixture.searchGate ?? [note];
      case 'history':
        return structuredClone(fixture.versions);
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
      case 'create_note': {
        const copy: Note = {
          id: 'copy',
          path: String(args.path),
          title: 'Recovered draft',
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
    const search = screen.getByRole('textbox', { name: 'Search notes' });
    fireEvent.change(search, { target: { value: 'Base note' } });
    await waitFor(() => expect(fixture.searchStarted).toHaveBeenCalledOnce());
    await userEvent.setup().click(screen.getByRole('button', { name: /Notebook Local notebook/ }));
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
    expect(sidebar.getByRole('button', { name: /^Other\s/ })).toBeDefined();
  });
  it('retains the current editor and saves pending text when the replacement cannot open', async () => {
    fixture.allowSave = true;
    fixture.openFailure = true;
    render(<App />);
    const editor = await screen.findByLabelText('Markdown editor');
    fireEvent.change(editor, { target: { value: '# Idea\n\nKeep my latest writing.' } });
    await userEvent.setup().click(screen.getByRole('button', { name: /Notebook Local notebook/ }));
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
