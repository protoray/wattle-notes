import { invoke, isTauri } from '@tauri-apps/api/core';
import type { AccountInfo, DeletedFolder, LinkInfo, Note, VaultInfo } from './types';
import { resolveTarget } from './content';
export const native = isTauri();

const examples = [
  [
    'Welcome.md',
    'Welcome',
    ['getting-started'],
    '# A little space for your thoughts\n\nGood notes start with a little room to think. This is yours.\n\nWattle Notes keeps your writing in ordinary Markdown files on your computer. When you connect Google Drive, the app encrypts the contents before they leave your device.\n\n## Make yourself at home\n\n- Write without waiting for a connection\n- Organise notes into folders and add a few tags\n- Connect ideas with [[A useful note]]\n- Find your way back with backlinks\n\n> Your words. Your files. A quieter place to work.\n\n## A few things to try\n\nCreate a note, switch to the reading view, or open the links panel. **⌘ / Ctrl + N** starts a new note. **⌘ / Ctrl + P** takes you to search.\n\nThis browser preview is temporary. Use the desktop app to save files and enable encrypted sync.\n',
  ],
  [
    'Ideas/A useful note.md',
    'A useful note',
    ['ideas', 'writing'],
    '# A useful note\n\nA useful note says one thing clearly. It has enough context to make sense when you come back later.\n\n## Leave a trail\n\nLink to related ideas rather than repeating them. A small collection of connected notes becomes more useful each time you revisit it.\n\nSee [[Welcome]] and [[Reading list]].\n',
  ],
  [
    'Reading/Reading list.md',
    'Reading list',
    ['reading'],
    '# Reading list\n\nA place for things worth returning to.\n\n- [ ] Read slowly\n- [ ] Capture an idea in your own words\n- [ ] Connect it to [[A useful note]]\n\n## Notes to self\n\nFewer highlights. More thinking.\n',
  ],
  [
    'Journal/Today.md',
    'Today',
    ['journal'],
    '# Today\n\n## What is on my mind?\n\n\n## One thing to carry forward\n\n\n',
  ],
] as const;
let demoNotes: Note[] = examples.map(([path, title, tags, content], i) => ({
  id: `preview-${i}`,
  path,
  title,
  tags: [...tags],
  content,
  hash: `preview-${i}-0`,
  modified: Date.now() / 1000 - i * 86400,
}));
const demoFolders = ['Ideas', 'Reading', 'Journal'];
const demoTrash: { entry: DeletedFolder; folders: string[]; notes: Note[] }[] = [];

export async function call<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (native) return invoke<T>(command, args);
  // Browser preview is explicitly temporary and never simulates cryptography or Drive sync.
  let result: unknown;
  switch (command) {
    case 'last_vault':
      result = 'preview';
      break;
    case 'open_vault':
    case 'vault_info':
      result = demoInfo();
      break;
    case 'webdav_info':
      result = { settings: { url: '', username: '' }, configured: false, last_backup: null };
      break;
    case 'account_info':
      result = {
        encrypted: false,
        unlocked: false,
        connected: false,
        bundled_client: false,
        settings: { client_id: '', client_secret: null },
      } satisfies AccountInfo;
      break;
    case 'create_note': {
      const path = String(args.path);
      if (demoNotes.some((n) => n.path.toLowerCase() === path.toLowerCase()))
        throw new Error('A note already uses this name');
      const title = path.split('/').pop()!.replace(/\.md$/, '');
      const note: Note = {
        id: crypto.randomUUID(),
        path,
        title,
        tags: [],
        content: `# ${title}\n\n`,
        hash: crypto.randomUUID(),
        modified: Date.now() / 1000,
      };
      demoNotes.unshift(note);
      result = note;
      break;
    }
    case 'save_note': {
      const note = demoNotes.find((n) => n.id === args.id);
      if (!note) throw new Error('Note not found');
      if (note.hash !== args.expected) throw new Error('The note changed; your draft is retained');
      Object.assign(note, {
        content: String(args.content),
        hash: crypto.randomUUID(),
        modified: Date.now() / 1000,
      });
      result = { ...note };
      break;
    }
    case 'rename_note': {
      const note = demoNotes.find((n) => n.id === args.id);
      if (!note) throw new Error('Note not found');
      Object.assign(note, {
        path: String(args.path),
        title: String(args.path).split('/').pop()!.replace(/\.md$/, ''),
      });
      result = { ...note };
      break;
    }
    case 'set_tags': {
      const note = demoNotes.find((n) => n.id === args.id);
      if (!note) throw new Error('Note not found');
      note.tags = args.tags as string[];
      result = { ...note };
      break;
    }
    case 'delete_note':
      demoNotes = demoNotes.filter((n) => n.id !== args.id);
      result = null;
      break;
    case 'create_folder':
      demoFolders.push(String(args.path));
      result = null;
      break;
    case 'delete_folder': {
      const path = String(args.path);
      if (!path || !demoInfo().folders.includes(path)) throw new Error('Notebook folder not found');
      const contains = (value: string) => value === path || value.startsWith(`${path}/`);
      demoTrash.push({
        entry: { id: crypto.randomUUID(), path, deleted_at: Date.now() / 1000 },
        folders: demoFolders.filter(contains),
        notes: demoNotes.filter((note) => note.path.startsWith(`${path}/`)),
      });
      demoNotes = demoNotes.filter((note) => !note.path.startsWith(`${path}/`));
      for (let index = demoFolders.length - 1; index >= 0; index--)
        if (contains(demoFolders[index])) demoFolders.splice(index, 1);
      result = null;
      break;
    }
    case 'deleted_folders':
      result = demoTrash.map(({ entry }) => entry);
      break;
    case 'restore_folder': {
      const index = demoTrash.findIndex(({ entry }) => entry.id === args.id);
      if (index < 0) throw new Error('Deleted notebook not found');
      const { entry, folders, notes } = demoTrash[index];
      if (
        demoFolders.some((path) => path === entry.path || path.startsWith(`${entry.path}/`)) ||
        demoNotes.some(
          (note) =>
            note.path === entry.path ||
            note.path.startsWith(`${entry.path}/`) ||
            notes.some((restored) => restored.id === note.id),
        )
      )
        throw new Error('A folder or page already uses this notebook’s path');
      demoFolders.push(...folders);
      demoNotes.push(...notes);
      demoTrash.splice(index, 1);
      result = null;
      break;
    }
    case 'search_notes':
      result = demoNotes.filter((n) =>
        (n.title + ' ' + n.content).toLowerCase().includes(String(args.query).toLowerCase()),
      );
      break;
    case 'note_links': {
      const note = demoNotes.find((n) => n.id === args.id);
      const extract = (text: string) =>
        [...text.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)].map((m) => m[1]);
      result = {
        outbound: extract(note?.content ?? '').map((target) => {
          const resolved = resolveTarget(note?.path ?? '', target, demoNotes);
          return { target, resolved_id: resolved.id, status: resolved.status };
        }),
        backlinks: demoNotes.filter(
          (n) =>
            n.id !== args.id &&
            extract(n.content).some((t) => resolveTarget(n.path, t, demoNotes).id === args.id),
        ),
      } satisfies LinkInfo;
      break;
    }
    case 'conflicts':
    case 'history':
    case 'discover_vaults':
      result = [];
      break;
    default:
      throw new Error(
        'This action requires the desktop app. Browser preview does not access your files or Google Drive.',
      );
  }
  return structuredClone(result) as T;
}
function demoInfo(): VaultInfo {
  return {
    root: 'Browser preview — session only',
    name: 'My notebook',
    notes: demoNotes,
    folders: demoFolders,
    status: { state: 'local', pending: 0, conflicts: 0, last_sync: null, message: null },
  };
}
