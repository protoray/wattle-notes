import { useEffect, useState } from 'react';
import { Cloud, Download, Upload } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { call, native } from './api';

export interface WebDavInfo {
  settings: { url: string; username: string };
  configured: boolean;
  last_backup: string | null;
}
interface Backup {
  name: string;
  size: number;
}
export default function NextcloudBackup({
  unlocked,
  onBackup,
  onOpenRestore,
  onBusyChange,
  expanded = false,
}: {
  unlocked: boolean;
  onBackup: () => Promise<string>;
  onOpenRestore: (root: string) => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  expanded?: boolean;
}) {
  const [info, setInfo] = useState<WebDavInfo | null>(null);
  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [backups, setBackups] = useState<Backup[]>([]);
  const [selected, setSelected] = useState('');
  const [secret, setSecret] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [restored, setRestored] = useState('');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  async function reload() {
    const next = await call<WebDavInfo>('webdav_info');
    setInfo(next);
    setUrl(next.settings.url);
    setUsername(next.settings.username);
  }
  useEffect(() => {
    void reload().catch((error) => setMessage(String(error)));
  }, []);
  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    onBusyChange?.(true);
    setMessage('');
    try {
      await action();
      await reload();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy('');
      onBusyChange?.(false);
    }
  }
  function label(backup: string) {
    const seconds = Number(backup.split('-')[0]);
    return Number.isFinite(seconds) ? new Date(seconds * 1000).toLocaleString() : backup;
  }
  return (
    <details className="settings-section nextcloud-backup" open={expanded}>
      <summary>
        <Cloud size={18} /> Nextcloud / WebDAV backup
      </summary>
      <p>
        Optional encrypted snapshots, separate from Google Drive sync. No Google account or OAuth
        client needed. Notes, attachments, and retained history are included.
      </p>
      {!native && <p className="notice">Nextcloud backups are available in the desktop app.</p>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run('Testing connection…', async () => {
            await call('configure_webdav', { url, username, password: password || null });
            setPassword('');
            setBackups([]);
            setSelected('');
            setMessage('Nextcloud connected. You can now back up or restore.');
          });
        }}
      >
        <label>
          WebDAV URL
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://cloud.example.com/remote.php/dav/files/username/"
            disabled={!native || !!busy}
          />
        </label>
        <p className="small muted">
          Copy this from Nextcloud → Files → Files settings → WebDAV. HTTPS is required.
        </p>
        <label>
          Nextcloud username
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="off"
            disabled={!native || !!busy}
          />
        </label>
        <label>
          Nextcloud app password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="off"
            placeholder={info?.configured ? 'Leave blank to use the saved app password' : ''}
            disabled={!native || !!busy}
          />
        </label>
        <p className="small muted">
          Create an app password in Nextcloud → Personal settings → Security. It is saved in this
          device’s secure credential store.
        </p>
        <button
          disabled={
            !native || !!busy || !url.trim() || !username.trim() || (!password && !info?.configured)
          }
        >
          Save &amp; test connection
        </button>
      </form>
      {info?.configured && (
        <>
          <div className="setting-row">
            <span className="connected-dot">Nextcloud connected</span>
            <button
              disabled={!!busy}
              onClick={() =>
                void run('Disconnecting…', async () => {
                  await call('disconnect_webdav');
                  setBackups([]);
                  setSelected('');
                  setMessage('Nextcloud disconnected. Existing backups remain on the server.');
                })
              }
            >
              Disconnect Nextcloud
            </button>
          </div>
          <div className="button-row">
            <button
              className="primary"
              disabled={!!busy || !unlocked}
              onClick={() =>
                void run('Creating encrypted backup…', async () => {
                  await onBackup();
                  setMessage('Encrypted backup saved to Nextcloud.');
                })
              }
            >
              <Upload size={15} /> Back up now
            </button>
            <button
              disabled={!!busy}
              onClick={() =>
                void run('Finding backups…', async () => {
                  const next = await call<Backup[]>('list_webdav_backups');
                  setBackups(next);
                  setMessage(
                    next.length
                      ? 'Choose a backup below to restore.'
                      : 'No completed backups found.',
                  );
                })
              }
            >
              <Download size={15} /> Find backups
            </button>
          </div>
          {!unlocked && (
            <p className="notice">
              Set up or unlock encryption in Protect your notes to create a backup. Restoration uses
              the original backup’s passphrase or recovery key.
            </p>
          )}
          {info.last_backup && (
            <p className="small muted">Last successful backup: {label(info.last_backup)}</p>
          )}
        </>
      )}
      {backups.length > 0 && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run('Restoring verified backup…', async () => {
              const parent = await open({
                directory: true,
                multiple: false,
                title: 'Choose where to create the restored notebook',
              });
              if (typeof parent !== 'string') return;
              try {
                const root = await call<string>('restore_webdav_backup', {
                  name: selected,
                  parent,
                  secret,
                  recovery,
                });
                setRestored(root);
                setMessage(`Backup restored to ${root}. Your existing notebook is unchanged.`);
              } finally {
                setSecret('');
              }
            });
          }}
        >
          <label>
            Backup to restore
            <select
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              disabled={!!busy}
            >
              <option value="">Choose a backup</option>
              {backups.map((backup) => (
                <option key={backup.name} value={backup.name}>
                  {label(backup.name)} · {(backup.size / 1048576).toFixed(1)} MiB ·{' '}
                  {backup.name.slice(-45, -9)}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={recovery}
              onChange={(event) => setRecovery(event.target.checked)}
              disabled={!!busy}
            />{' '}
            Use a recovery key for this backup
          </label>
          <label>
            {recovery ? 'Backup recovery key' : 'Backup passphrase'}
            <input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              autoComplete="off"
              disabled={!!busy}
            />
          </label>
          <p className="small muted">
            Creates a new restored folder in the location you choose, outside the current notebook.
            All files are authenticated before the restored folder is published.
          </p>
          <button disabled={!!busy || !selected || !secret}>Restore backup to a new folder</button>
        </form>
      )}
      {restored && (
        <button
          disabled={!!busy}
          onClick={() => void run('Opening restored notebook…', () => onOpenRestore(restored))}
        >
          Open restored notebook
        </button>
      )}
      {busy && (
        <p className="notice" role="status">
          {busy}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <p className="small muted">
        Manual full backups, up to 4 GiB each and 100 MiB per file. Saved in “Wattle Notes Backups”
        on your server. Old backups are retained; interrupted uploads are not shown as completed
        backups.
      </p>
    </details>
  );
}
