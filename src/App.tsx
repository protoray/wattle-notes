import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  ArrowLeft,
  BookOpen,
  ChevronRight,
  Cloud,
  FileText,
  FolderOpen,
  History,
  Link2,
  Menu,
  PanelRight,
  Palette,
  Paperclip,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { call, native } from './api';
import { replaceBody, resolveTarget, splitContent } from './content';
import { attachmentMarkdown, importClipboardImages } from './clipboard-images';
import type { AccountInfo, LinkInfo, Note, Revision, SyncStatus, VaultInfo } from './types';
import Modal from './Modal';
import NotebookPages from './NotebookPages';
import SidebarUtilities from './SidebarUtilities';
import { pageNotebook } from './notebook-tree';
import Preview from './Preview';
import LiveEditor from './LiveEditor';
import Settings from './Settings';
import AppUpdatesPanel, { UpdateProgress } from './AppUpdates';
import { useAppUpdates } from './useAppUpdates';
import { useSyncProgress, syncProgressLabel } from './useSyncProgress';
import ConflictView from './ConflictView';
import HistoryView from './HistoryView';
import Appearance from './Appearance';
import { alternateTheme, applyTheme, isDarkTheme, readTheme, themes } from './themes';

type Dialog =
  | 'new-note'
  | 'new-folder'
  | 'rename'
  | 'tags'
  | 'delete'
  | 'settings'
  | 'appearance'
  | 'conflicts'
  | 'history'
  | null;
const initialLinks: LinkInfo = { outbound: [], backlinks: [] };

export default function App() {
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [historyItem, setHistoryItem] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [folder, setFolder] = useState('');
  const [tag, setTag] = useState('');
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Note[] | null>(null);
  const [mode, setMode] = useState<'edit' | 'split' | 'read'>('edit');
  const [showLinks, setShowLinks] = useState(false);
  const [linkInfo, setLinkInfo] = useState<LinkInfo>(initialLinks);
  const [settingsTarget, setSettingsTarget] = useState<'google' | 'nextcloud'>('google');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [field, setField] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const syncProgress = useSyncProgress(syncing);
  const [saveTick, setSaveTick] = useState(0);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [theme, setTheme] = useState(readTheme);
  const dark = isDarkTheme(theme);
  const [sidebar, setSidebar] = useState(true);
  const hasVault = info !== null;
  const base = useRef<Note | null>(null);
  const documentGeneration = useRef(0);
  const draftRef = useRef('');
  const savingPromise = useRef<Promise<Note> | null>(null);
  const busySync = useRef(false);
  const accountRef = useRef<AccountInfo | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const actionRef = useRef<{ create: () => void; save: () => void }>({
    create: () => {},
    save: () => {},
  });
  const closeDialog = useCallback(() => {
    setDialog(null);
    setField('');
  }, []);
  const assign = useCallback((note: Note | null) => {
    documentGeneration.current += 1;
    base.current = note;
    draftRef.current = note?.content ?? '';
    setSelectedId(note?.id ?? null);
    if (note) setFolder(pageNotebook(note.path));
    setDraft(note?.content ?? '');
    setLinkInfo(initialLinks);
  }, []);
  const saveCurrent = useCallback(async function flush(): Promise<void> {
    if (savingPromise.current) {
      await savingPromise.current;
      return flush();
    }
    const note = base.current;
    const content = draftRef.current;
    if (!note || content === note.content) return;
    setSaving(true);
    const promise = call<Note>('save_note', { id: note.id, content, expected: note.hash });
    savingPromise.current = promise;
    try {
      const saved = await promise;
      setInfo((previous) =>
        previous
          ? { ...previous, notes: previous.notes.map((n) => (n.id === saved.id ? saved : n)) }
          : previous,
      );
      if (base.current?.id === saved.id) {
        base.current = saved;
        if (draftRef.current === content) {
          draftRef.current = saved.content;
          setDraft(saved.content);
        }
      }
    } finally {
      savingPromise.current = null;
      setSaving(false);
    }
    if (base.current?.id === note.id && draftRef.current !== base.current.content) return flush();
  }, []);
  const updates = useAppUpdates(saveCurrent);
  useEffect(() => {
    if (!native) return;
    const registration = import('@tauri-apps/api/event').then(({ listen }) =>
      listen('notes-close-requested', () => {
        if (updates.locked.current) return;
        void saveCurrent()
          .then(() => call('finish_exit'))
          .catch((error) => setMessage(`Save before closing: ${String(error)}`));
      }),
    );
    return () => {
      void registration.then((unlisten) => unlisten());
    };
  }, [saveCurrent, updates.locked]);
  const refresh = useCallback(async () => {
    const next = await call<VaultInfo>('vault_info');
    setInfo(next);
    const current = base.current;
    if (!current) return;
    const updated = next.notes.find((n) => n.id === current.id);
    if (draftRef.current === current.content) {
      if (updated && updated.hash !== current.hash) assign(updated);
      else if (!updated) assign(next.notes[0] ?? null);
    }
  }, [assign]);
  const refreshAccount = useCallback(async () => {
    const next = await call<AccountInfo>('account_info');
    accountRef.current = next;
    setAccount(next);
  }, []);
  const syncNow = useCallback(async () => {
    if (busySync.current) return;
    busySync.current = true;
    try {
      setSyncing(true);
      await saveCurrent();
      const status = await call<SyncStatus>('sync_now');
      setInfo((v) => (v ? { ...v, status } : v));
      await refresh();
      return status;
    } catch (error) {
      setMessage(String(error));
      await refresh().catch(() => {});
    } finally {
      busySync.current = false;
      setSyncing(false);
      setSaveTick((n) => n + 1);
    }
  }, [refresh, saveCurrent]);
  useEffect(() => {
    let cancelled = false;
    void call<string | null>('last_vault')
      .then(async (root) => {
        if (!root) return;
        const next = await call<VaultInfo>('open_vault', { root });
        if (cancelled) return;
        setInfo(next);
        assign(next.notes[0] ?? null);
        await refreshAccount();
      })
      .catch((e) => {
        if (!cancelled) setMessage(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [assign, refreshAccount]);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  useEffect(() => {
    if (
      !selectedId ||
      draftRef.current === base.current?.content ||
      dialog === 'conflicts' ||
      dialog === 'history'
    )
      return;
    const timer = setTimeout(() => void saveCurrent().catch((e) => setMessage(String(e))), 500);
    return () => clearTimeout(timer);
  }, [draft, selectedId, saveTick, saveCurrent, dialog]);
  useEffect(() => {
    if (!hasVault) return;
    const watch = setInterval(() => {
      if (!busySync.current && !savingPromise.current)
        void refresh().catch((e) => setMessage(String(e)));
    }, 3000);
    const poll = setInterval(() => {
      const a = accountRef.current;
      if (a?.connected && a.unlocked) void syncNow();
    }, 30000);
    const reconnect = () => {
      const a = accountRef.current;
      if (a?.connected && a.unlocked) void syncNow();
    };
    window.addEventListener('online', reconnect);
    return () => {
      clearInterval(watch);
      clearInterval(poll);
      window.removeEventListener('online', reconnect);
    };
  }, [hasVault, refresh, syncNow]);
  useEffect(() => {
    if (!hasVault || !account?.connected || !account.unlocked) return;
    const timer = setTimeout(() => void syncNow(), 5000);
    return () => clearTimeout(timer);
  }, [draft, account?.connected, account?.unlocked, hasVault, syncNow]);
  useEffect(() => {
    let cancelled = false;
    if (!selectedId) return;
    void call<LinkInfo>('note_links', { id: selectedId })
      .then((result) => {
        if (!cancelled) setLinkInfo(result);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedId, info?.notes, draft]);
  useEffect(() => {
    let cancelled = false;
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(
      () =>
        void call<Note[]>('search_notes', { query })
          .then((notes) => {
            if (!cancelled) setSearchResults(notes);
          })
          .catch((e) => setMessage(String(e))),
      150,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, info?.notes]);
  useEffect(() => {
    actionRef.current = {
      create: () => {
        setField('');
        setDialog('new-note');
      },
      save: () => void saveCurrent().catch((e) => setMessage(String(e))),
    };
  }, [saveCurrent]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (updates.locked.current) {
        event.preventDefault();
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 's') {
        event.preventDefault();
        actionRef.current.save();
      }
      if (event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setSidebar(true);
        requestAnimationFrame(() => searchInput.current?.focus());
      }
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        actionRef.current.create();
      }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [updates.locked]);
  useEffect(() => {
    function before(event: BeforeUnloadEvent) {
      if (base.current && draftRef.current !== base.current.content) {
        event.preventDefault();
        event.returnValue = '';
      }
    }
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, []);
  const allTags = useMemo(
    () => [...new Set(info?.notes.flatMap((n) => n.tags) ?? [])].sort(),
    [info?.notes],
  );
  const filteredNotes = (searchResults ?? info?.notes ?? []).filter(
    (n) => !tag || n.tags.includes(tag),
  );
  const selected = info?.notes.find((n) => n.id === selectedId) ?? base.current;
  const editorBody = splitContent(draft).body;
  const wordCount = editorBody.trim() ? editorBody.trim().split(/\s+/).length : 0;
  const onPasteImageFiles = useCallback(
    async (files: File[]) => {
      const note = base.current;
      const root = info?.root;
      if (!native || !note || !root) return null;
      const generation = documentGeneration.current;
      const isCurrent = () =>
        generation === documentGeneration.current && base.current?.id === note.id;
      try {
        return await importClipboardImages(
          files,
          { root, id: note.id, path: note.path },
          isCurrent,
          (args) => call<string>('import_clipboard_image', args),
        );
      } catch (error) {
        if (isCurrent()) setMessage(String(error));
        return null;
      }
    },
    [info?.root],
  );
  async function choose(note: Note) {
    try {
      await saveCurrent();
      assign(note);
    } catch (e) {
      setMessage(String(e));
    }
  }
  async function pickVault() {
    try {
      await saveCurrent();
      if (!native) return;
      const root = await open({
        directory: true,
        multiple: false,
        title: 'Choose a folder for your notes',
      });
      if (typeof root !== 'string') return;
      await openNotebook(root);
    } catch (e) {
      setMessage(String(e));
    }
  }
  async function openNotebook(root: string) {
    documentGeneration.current += 1;
    await saveCurrent();
    const next = await call<VaultInfo>('open_vault', { root });
    setInfo(next);
    assign(next.notes[0] ?? null);
    setFolder(pageNotebook(next.notes[0]?.path ?? ''));
    setTag('');
    setQuery('');
    setSearchResults(null);
    setHistoryItem(null);
    setMessage('');
    accountRef.current = null;
    setAccount(null);
    closeDialog();
    await refreshAccount();
  }
  async function submitDialog() {
    try {
      await saveCurrent();
      if (dialog === 'new-note') {
        const path = `${folder ? folder + '/' : ''}${field.trim().replace(/\.md$/, '')}.md`;
        const note = await call<Note>('create_note', { path });
        await refresh();
        assign(note);
        setQuery('');
        setSearchResults(null);
        setTag('');
      }
      if (dialog === 'new-folder') {
        const path = field.trim();
        await call('create_folder', { path });
        assign(null);
        setFolder(path);
        setQuery('');
        setSearchResults(null);
        setTag('');
      }
      if (dialog === 'rename' && selected) {
        const note = await call<Note>('rename_note', {
          id: selected.id,
          path: field.trim().endsWith('.md') ? field.trim() : field.trim() + '.md',
        });
        assign(note);
      }
      if (dialog === 'tags' && selected) {
        const note = await call<Note>('set_tags', {
          id: selected.id,
          tags: field
            .split(',')
            .map((s) => s.trim().replace(/^#/, ''))
            .filter(Boolean),
        });
        assign(note);
      }
      if (dialog === 'delete' && selected) {
        await call('delete_note', { id: selected.id });
        assign(null);
      }
      closeDialog();
      await refresh();
    } catch (e) {
      setMessage(String(e));
    }
  }
  async function attachment() {
    const note = base.current;
    const root = info?.root;
    if (!note || !root) return;
    const generation = documentGeneration.current;
    const isCurrent = () =>
      generation === documentGeneration.current && base.current?.id === note.id;
    try {
      const source = await open({ multiple: false, title: 'Attach a file' });
      if (typeof source !== 'string' || !isCurrent()) return;
      await saveCurrent();
      if (!isCurrent()) return;
      const path = await call<string>('import_attachment', {
        source,
        expectedRoot: root,
        noteId: note.id,
      });
      if (!isCurrent()) return;
      const image = /\.(png|jpe?g|gif|webp|avif)$/i.test(path);
      const content = draftRef.current + `\n${attachmentMarkdown(note.path, path, image)}\n`;
      draftRef.current = content;
      setDraft(content);
    } catch (e) {
      if (isCurrent()) setMessage(String(e));
    }
  }
  async function importExport(importing: boolean) {
    try {
      await saveCurrent();
      const path = await open({
        directory: true,
        multiple: false,
        title: importing ? 'Import a Markdown folder' : 'Export notes to an empty folder',
      });
      if (typeof path !== 'string') return;
      await call(
        importing ? 'import_folder' : 'export_vault',
        importing ? { source: path } : { destination: path },
      );
      await refresh();
      setMessage(importing ? 'Folder imported.' : 'Notes and attachments exported.');
    } catch (e) {
      setMessage(String(e));
    }
  }
  async function openLink(target: string, wiki: boolean) {
    if (!selected) return;
    const resolved = resolveTarget(selected.path, target, info?.notes ?? [], wiki);
    if (resolved.id) {
      const note = info?.notes.find((n) => n.id === resolved.id);
      if (note) await choose(note);
    } else
      setMessage(
        resolved.status === 'ambiguous'
          ? `“${target}” matches more than one note. Use its folder path.`
          : `“${target}” does not resolve to a note.`,
      );
  }
  function startDialog(next: Dialog, value = '') {
    setMessage('');
    setField(value);
    setDialog(next);
  }
  const onResolved = (item: string) => {
    void (async () => {
      const current = base.current;
      if (current?.id === item && draftRef.current !== current.content) {
        const versions = await call<Revision[]>('history', { item });
        if (!versions.some((version) => version.content === draftRef.current)) {
          const stem = [...current.title].slice(0, 40).join('');
          const directory = current.path.split('/').slice(0, -1).join('/');
          const path = `${directory ? directory + '/' : ''}${stem} (recovered draft ${crypto.randomUUID().slice(0, 8)}).md`;
          const copy = await call<Note>('create_note', { path });
          await call('save_note', { id: copy.id, content: draftRef.current, expected: copy.hash });
          setMessage(`Your latest unsaved draft was preserved as “${path}”.`);
        }
      }
      const next = await call<VaultInfo>('vault_info');
      setInfo(next);
      if (base.current?.id === item)
        assign(next.notes.find((note) => note.id === item) ?? next.notes[0] ?? null);
    })().catch((error) => setMessage(String(error)));
  };
  const onChanged = () => {
    void refresh().catch((e) => setMessage(String(e)));
    void refreshAccount().catch((e) => setMessage(String(e)));
  };

  if (!info)
    return (
      <main className="welcome-screen" inert={updates.busy}>
        <div className="welcome-mark">
          <BookOpen size={35} />
        </div>
        <span className="eyebrow">WATTLE NOTES</span>
        <h1>
          A little space
          <br />
          for your thoughts.
        </h1>
        <p>
          Plain Markdown on your computer.
          <br />
          Encrypted notes on Google Drive.
        </p>
        <button className="primary large" onClick={() => void pickVault()}>
          <FolderOpen size={18} /> Open a notes folder
        </button>
        <p className="small muted">
          Choose an existing Markdown folder or an empty folder to start.
        </p>
        {message && <p className="notice">{message}</p>}
        <AppUpdatesPanel updates={updates} />
        <div className="welcome-footer">
          <ShieldCheck size={16} />
          Your words. Your files.
        </div>
        <UpdateProgress updates={updates} />
      </main>
    );
  return (
    <div className={`app-shell ${!sidebar ? 'sidebar-hidden' : ''}`} inert={updates.busy}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <BookOpen size={19} />
          </div>
          <span>
            wattle notes<span className="alpha">α</span>
          </span>
        </div>
        <button className="vault-picker" onClick={() => void pickVault()} title={info.root}>
          <span className="vault-avatar">{info.name[0].toUpperCase()}</span>
          <span>
            <strong>{info.name}</strong>
            <small>{native ? 'Workspace folder' : 'Browser preview'}</small>
          </span>
          <ChevronRight size={15} />
        </button>
        <div className="search-box">
          <Search size={16} />
          <input
            ref={searchInput}
            aria-label="Search pages"
            placeholder="Search your pages"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="icon-button" aria-label="Clear search" onClick={() => setQuery('')}>
              <X size={13} />
            </button>
          )}
        </div>
        <details className="organization">
          <summary>
            Tags <ChevronRight size={14} />
          </summary>
          <div className="organization-content">
            <div className="tag-list">
              {allTags.length ? (
                allTags.map((t) => (
                  <button
                    className={`sidebar-action ${tag === t ? 'active' : ''}`}
                    key={t}
                    onClick={() => setTag(tag === t ? '' : t)}
                  >
                    <span className="tag-hash">#</span>
                    <span>{t}</span>
                  </button>
                ))
              ) : (
                <p className="small muted sidebar-hint">Tags keep related ideas together.</p>
              )}
            </div>
          </div>
        </details>
        {(query.trim() || tag) && (
          <div className="sidebar-filter-state">
            <span>{tag ? `#${tag}` : 'Search results'}</span>
            <button
              onClick={() => {
                setTag('');
                setQuery('');
                setSearchResults(null);
              }}
            >
              All pages
            </button>
          </div>
        )}
        <NotebookPages
          info={info}
          selectedId={selectedId}
          selectedFolder={folder}
          filteredNotes={filteredNotes}
          filterActive={!!query.trim() || !!tag}
          query={query}
          onSelectNotebook={setFolder}
          onSelectPage={(note) => void choose(note)}
          onNewNotebook={(parent) => startDialog('new-folder', parent ? `${parent}/` : '')}
          onNewPage={(path) => {
            setFolder(path);
            startDialog('new-note');
          }}
        />
        <SidebarUtilities
          account={account}
          native={native}
          dark={dark}
          updateAvailable={!!updates.available}
          onToggleDark={() => setTheme(alternateTheme(theme))}
          onGoogle={() => {
            setSettingsTarget('google');
            startDialog('settings');
          }}
          onNextcloud={() => {
            setSettingsTarget('nextcloud');
            startDialog('settings');
          }}
          onHistory={() => {
            setHistoryItem(null);
            startDialog('history');
          }}
          onSettings={() => startDialog('settings')}
          onAppearance={() => startDialog('appearance')}
        />
      </aside>
      <main className="workspace">
        <header className="workspace-toolbar">
          <div className="breadcrumbs">
            <button
              className="icon-button"
              aria-label="Toggle notebook sidebar"
              onClick={() => setSidebar(!sidebar)}
            >
              <Menu size={17} />
            </button>
            <span>
              {selected?.path.includes('/')
                ? selected.path.split('/').slice(0, -1).join(' / ')
                : info.name}
            </span>
            <ChevronRight size={13} />
            <strong>{selected?.title ?? 'Your notebook'}</strong>
          </div>
          <div className="toolbar-right">
            <span
              className={`sync-label ${syncing ? 'syncing' : ''}`}
              title={syncing ? syncProgressLabel(syncProgress) : undefined}
            >
              <Cloud size={15} />
              {syncing
                ? syncProgress?.total
                  ? `Syncing… ${syncProgress.completed}/${syncProgress.total}`
                  : 'Syncing…'
                : native
                  ? account?.connected
                    ? account.unlocked
                      ? 'Drive connected'
                      : 'Sync locked'
                    : 'Local only'
                  : 'Preview'}
            </span>
            <button
              className="icon-button"
              aria-label={account?.connected ? 'Sync now' : 'Connect Google Drive'}
              disabled={!native || syncing || (!!account?.connected && !account.unlocked)}
              onClick={() => (account?.connected ? void syncNow() : startDialog('settings'))}
            >
              <Cloud size={17} />
            </button>
            <button
              className={`icon-button ${showLinks ? 'active' : ''}`}
              aria-label="Toggle links panel"
              onClick={() => setShowLinks(!showLinks)}
            >
              <PanelRight size={18} />
            </button>
          </div>
        </header>
        {message && (
          <div className="app-notice" role="status">
            <span>{message}</span>
            <button
              className="icon-button"
              aria-label="Dismiss message"
              onClick={() => setMessage('')}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {info.status.conflicts > 0 && (
          <button className="conflict-banner" onClick={() => startDialog('conflicts')}>
            {info.status.conflicts}{' '}
            {info.status.conflicts === 1 ? 'conflict needs' : 'conflicts need'} your review{' '}
            <ChevronRight size={16} />
          </button>
        )}
        {selected ? (
          <>
            <div className="document-heading">
              <div>
                <div className="eyebrow">PAGE</div>
                <h1>{selected.title}</h1>
                <div className="document-meta">
                  <span>Markdown page</span>
                  <span className="meta-dot">·</span>
                  <span>{wordCount} words</span>
                  <button
                    className="tags-button"
                    onClick={() => startDialog('tags', selected.tags.join(', '))}
                  >
                    {selected.tags.length
                      ? selected.tags.map((t) => `#${t}`).join('  ')
                      : '+ Add tags'}
                  </button>
                </div>
              </div>
              <div className="mode-switch" role="group" aria-label="Editor view">
                <button className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>
                  Write
                </button>
                <button
                  className={mode === 'split' ? 'active' : ''}
                  onClick={() => setMode('split')}
                >
                  Split
                </button>
                <button className={mode === 'read' ? 'active' : ''} onClick={() => setMode('read')}>
                  Read
                </button>
              </div>
            </div>
            <div className="document-tools">
              <div>
                <button onClick={() => startDialog('rename', selected.path)}>Rename</button>
                <button disabled={!native} onClick={() => void attachment()}>
                  <Paperclip size={14} />
                  Attach
                </button>
                <button
                  onClick={() => {
                    setHistoryItem(selectedId);
                    startDialog('history');
                  }}
                >
                  <History size={14} />
                  History
                </button>
              </div>
              <button
                className="icon-button danger"
                aria-label="Delete page"
                onClick={() => startDialog('delete')}
              >
                <Trash2 size={15} />
              </button>
            </div>
            <div className={`document-body ${mode} ${showLinks ? 'has-links' : ''}`}>
              <div className="writing-area">
                <LiveEditor
                  key={`${info?.root}:${selected.id}:${selected.path}`}
                  noteId={selected.id}
                  value={editorBody}
                  dark={dark}
                  rendered={mode === 'read'}
                  onChange={(value) => {
                    const content = replaceBody(draftRef.current, value);
                    draftRef.current = content;
                    setDraft(content);
                  }}
                  onLink={(target, wiki) => void openLink(target, wiki)}
                  onPasteImageFiles={native ? onPasteImageFiles : undefined}
                />
                {mode === 'split' && (
                  <div className="preview-pane">
                    <Preview
                      key={`${info?.root}:${selected.id}:${selected.path}`}
                      note={selected}
                      content={draft}
                      onLink={(target, wiki) => void openLink(target, wiki)}
                    />
                  </div>
                )}
              </div>
              {showLinks && (
                <aside className="links-panel">
                  <h3>
                    <Link2 size={16} />
                    Connected ideas
                  </h3>
                  <div className="section-label">LINKS IN THIS NOTE</div>
                  {linkInfo.outbound.length ? (
                    linkInfo.outbound.map((link, i) => (
                      <button
                        className="link-card"
                        key={`${link.target}-${i}`}
                        onClick={() => void openLink(link.target, true)}
                      >
                        <FileText size={14} />
                        <span>
                          {link.target}
                          <small>
                            {link.status === 'resolved'
                              ? 'Linked note'
                              : link.status === 'ambiguous'
                                ? 'Multiple matches'
                                : 'Not found'}
                          </small>
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className="small muted">Link an idea with [[a note title]].</p>
                  )}
                  <div className="section-label">BACKLINKS</div>
                  {linkInfo.backlinks.length ? (
                    linkInfo.backlinks.map((note) => (
                      <button className="link-card" key={note.id} onClick={() => void choose(note)}>
                        <ArrowLeft size={14} />
                        <span>
                          {note.title}
                          <small>{note.path}</small>
                        </span>
                      </button>
                    ))
                  ) : (
                    <p className="small muted">Notes linking here will appear here.</p>
                  )}
                </aside>
              )}
            </div>
            <footer className="workspace-footer">
              <span>
                <span className="status-dot" />
                {saving
                  ? 'Saving…'
                  : draft !== base.current?.content
                    ? 'Unsaved changes'
                    : native
                      ? 'Saved locally'
                      : 'Preview changes · session only'}
              </span>
              <span>
                {wordCount} words<span className="footer-divider">/</span>
                {editorBody.length} characters
              </span>
              <button onClick={() => startDialog('settings')}>
                <ShieldCheck size={13} />{' '}
                {account?.encrypted ? 'Encrypted Drive sync' : 'Your files stay yours'}
              </button>
            </footer>
          </>
        ) : (
          <div className="empty-document">
            <BookOpen size={42} />
            <h1>Start with a thought.</h1>
            <p>Create a page, or bring an existing Markdown folder.</p>
            <div className="button-row">
              <button className="primary" onClick={() => startDialog('new-note')}>
                <Plus size={17} />
                New page
              </button>
              <button disabled={!native} onClick={() => void importExport(true)}>
                Import a folder
              </button>
            </div>
          </div>
        )}
      </main>
      {dialog && (
        <Modal
          title={
            (
              {
                'new-note': 'A new page',
                'new-folder': 'A new notebook',
                rename: 'Rename page',
                tags: 'Page tags',
                delete: 'Delete this page?',
                settings: 'Your notebook settings',
                appearance: 'Appearance',
                conflicts: 'Resolve conflicts',
                history: 'History & trash',
              } as const
            )[dialog]
          }
          onClose={closeDialog}
          wide={['conflicts', 'history'].includes(dialog)}
        >
          {['new-note', 'new-folder', 'rename', 'tags'].includes(dialog) && (
            <form
              className="dialog-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submitDialog();
              }}
            >
              <label>
                {dialog === 'tags'
                  ? 'Tags, separated by commas'
                  : dialog === 'new-folder'
                    ? 'Notebook name'
                    : dialog === 'rename'
                      ? 'Filename, including folder'
                      : 'Page name'}
                <input
                  value={field}
                  onChange={(e) => setField(e.target.value)}
                  placeholder={
                    dialog === 'tags'
                      ? 'ideas, reading'
                      : dialog === 'new-note'
                        ? 'An idea worth keeping'
                        : 'Folder / name'
                  }
                />
              </label>
              {dialog === 'new-note' && (
                <p className="small muted">Saved in {folder || info.name} as Markdown.</p>
              )}
              <div className="button-row">
                <button type="button" onClick={closeDialog}>
                  Cancel
                </button>
                <button className="primary" disabled={!field.trim() && dialog !== 'tags'}>
                  {' '}
                  {dialog === 'rename' ? 'Rename' : dialog === 'tags' ? 'Save tags' : 'Create'}
                </button>
              </div>
            </form>
          )}
          {dialog === 'delete' && (
            <div className="dialog-form">
              <p>
                “{selected?.title}” will be removed from your notebook. Its saved versions remain in
                History &amp; trash.
              </p>
              <div className="button-row">
                <button onClick={closeDialog}>Keep page</button>
                <button className="danger-button" onClick={() => void submitDialog()}>
                  Delete page
                </button>
              </div>
            </div>
          )}
          {dialog === 'appearance' && (
            <Appearance theme={theme} onChange={setTheme} onClose={closeDialog} />
          )}
          {dialog === 'settings' && (
            <>
              <AppUpdatesPanel updates={updates} />
              <div className="settings-section appearance-summary">
                <div>
                  <h3>Appearance</h3>
                  <p className="small muted">
                    {themes.find((option) => option.id === theme)!.name}
                  </p>
                </div>
                <button onClick={() => startDialog('appearance')}>
                  <Palette size={15} /> Choose theme
                </button>
              </div>
              <Settings
                syncing={syncing}
                syncProgress={syncProgress}
                initialSection={settingsTarget}
                onChanged={onChanged}
                onSync={syncNow}
                onBackup={async () => {
                  await saveCurrent();
                  return call<string>('backup_webdav');
                }}
                onOpenRestore={openNotebook}
              />
              <div className="settings-section file-actions">
                <h3>Your local files</h3>
                <div className="button-row">
                  <button disabled={!native} onClick={() => void importExport(true)}>
                    Import Markdown folder
                  </button>
                  <button disabled={!native} onClick={() => void importExport(false)}>
                    Export notebook
                  </button>
                  <button disabled={!native} onClick={() => void pickVault()}>
                    <FolderOpen size={15} />
                    Open another folder
                  </button>
                </div>
              </div>
            </>
          )}
          {dialog === 'conflicts' && <ConflictView onChanged={onResolved} />}{' '}
          {dialog === 'history' && <HistoryView item={historyItem} onChanged={onResolved} />}
        </Modal>
      )}
      <UpdateProgress updates={updates} />
    </div>
  );
}
