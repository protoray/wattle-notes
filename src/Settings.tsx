import { useEffect, useRef, useState } from 'react';
import { Cloud, ExternalLink, KeyRound, LockKeyhole, ShieldCheck, Upload } from 'lucide-react';
import { call, native } from './api';
import type { AccountInfo, RemoteVault, SyncStatus, SyncProgress } from './types';
import { syncProgressLabel } from './useSyncProgress';
import { parseDesktopClient } from './oauth-config';
import NextcloudBackup from './NextcloudBackup';
export default function Settings({
  onChanged,
  onSync,
  onBackup,
  onOpenRestore,
  initialSection = 'google',
  syncing = false,
  syncProgress = null,
}: {
  onChanged: () => void;
  onSync: () => Promise<SyncStatus | undefined>;
  onBackup: () => Promise<string>;
  onOpenRestore: (root: string) => Promise<void>;
  initialSection?: 'google' | 'nextcloud';
  syncing?: boolean;
  syncProgress?: SyncProgress | null;
}) {
  const [provider, setProvider] = useState(initialSection);
  const [backupBusy, setBackupBusy] = useState(false);
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [accountError, setAccountError] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [secret, setSecret] = useState('');
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [remember, setRemember] = useState(false);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [remoteVaults, setRemoteVaults] = useState<RemoteVault[]>([]);
  const [remoteId, setRemoteId] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [operation, setOperation] = useState('');
  const [setupRequested, setSetupRequested] = useState(false);
  const setupPanel = useRef<HTMLDetailsElement>(null);
  const clientImport = useRef<HTMLInputElement>(null);
  const [requestBusy, setBusy] = useState(false);
  const busy = requestBusy || backupBusy;
  const [message, setMessage] = useState('');
  const showDeveloperSetup = import.meta.env.DEV && account?.bundled_client === false;
  async function reload() {
    setAccountError('');
    try {
      const next = await call<AccountInfo>('account_info');
      setAccount(next);
      setClientId(next.settings.client_id);
      setClientSecret(next.settings.client_secret ?? '');
    } catch (error) {
      setAccountError(String(error));
      throw error;
    }
  }
  useEffect(() => {
    void reload().catch((e) => setMessage(String(e)));
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await action();
      await reload();
      onChanged();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  function externalLink(url: string, label: string) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          if (native) {
            event.preventDefault();
            void call('open_external', { url }).catch((error) => setMessage(String(error)));
          }
        }}
      >
        {label}
        <ExternalLink size={12} />
      </a>
    );
  }
  async function importClient(file: File) {
    try {
      if (file.size > 65536) throw new Error('Choose a client JSON file smaller than 64 KiB.');
      const imported = parseDesktopClient(await file.text());
      setClientId(imported.clientId);
      setClientSecret(imported.clientSecret);
      setSetupRequested(false);
      setMessage('Client loaded. Select Sign in with Google to connect.');
    } catch (error) {
      setMessage(String(error));
    }
  }
  return (
    <div className="settings-content">
      {!native && (
        <div className="notice">
          You’re exploring a browser preview. File storage, encryption, and Google Drive are
          available in the desktop app.
        </div>
      )}
      <div className="privacy-note">
        <ShieldCheck size={23} />
        <div>
          <strong>Private in the cloud. Open on your computer.</strong>
          <p>
            Local notes and attachments are ordinary, unencrypted files. Cloud storage receives
            encrypted contents, with readable filenames and folders.
          </p>
        </div>
      </div>
      <div className="provider-choices" role="group" aria-label="Cloud storage options">
        <button
          aria-pressed={provider === 'google'}
          disabled={busy}
          onClick={() => {
            setProvider('google');
            setRestoring(false);
          }}
        >
          Google Drive sync
        </button>
        <button
          aria-pressed={provider === 'nextcloud'}
          disabled={busy}
          onClick={() => {
            setProvider('nextcloud');
            setRestoring(false);
          }}
        >
          Nextcloud backup
        </button>
      </div>
      {provider === 'nextcloud' && (
        <NextcloudBackup
          unlocked={!!account?.unlocked}
          onBackup={onBackup}
          onOpenRestore={onOpenRestore}
          onBusyChange={setBackupBusy}
          expanded
        />
      )}
      {provider === 'google' && (
        <section className="settings-section drive-setup">
          <h3>
            <span className="setup-number">1</span> Connect Google Drive
          </h3>
          <p>
            Your notes stay on this computer. Sign in to sync encrypted copies across your devices.
          </p>
          <p className="small muted">
            Google access is limited to files created by Wattle Notes or made available to it. Note
            contents are encrypted before upload; filenames and folders remain visible to Google.{' '}
            {externalLink('https://wattlenotes.app/privacy/', 'Privacy Policy')}
            {' · '}
            {externalLink('https://wattlenotes.app/terms-of-service/', 'Terms of Service')}
          </p>
          {!account?.connected ? (
            <>
              <button
                className="primary google-sign-in"
                disabled={!native || busy || !account || (!clientId.trim() && !showDeveloperSetup)}
                onClick={() => {
                  if (!clientId.trim()) {
                    setSetupRequested(true);
                    if (setupPanel.current) setupPanel.current.open = true;
                    requestAnimationFrame(() => clientImport.current?.focus());
                    return;
                  }
                  setOperation('sign-in');
                  void run(async () => {
                    if (!account?.bundled_client) {
                      await call('save_oauth_settings', {
                        clientId,
                        clientSecret: clientSecret || null,
                      });
                    }
                    await call('connect_drive');
                    setMessage(
                      'Google Drive connected. Next, protect your notes or restore an existing vault.',
                    );
                  });
                }}
              >
                <Cloud size={18} />{' '}
                {busy && operation === 'sign-in'
                  ? 'Waiting for Google…'
                  : !account
                    ? accountError
                      ? 'Google connection unavailable'
                      : 'Loading Google connection…'
                    : clientId.trim()
                      ? 'Sign in with Google'
                      : showDeveloperSetup
                        ? 'Set up Google sign-in'
                        : 'Google sign-in unavailable'}
                <ExternalLink size={15} />
              </button>
              <p className="small muted">
                {!account
                  ? accountError
                    ? 'Could not load Google connection settings. Try again.'
                    : 'Loading Google connection settings…'
                  : clientId.trim()
                    ? 'Opens Google in your default browser. Sign in there, then return here.'
                    : showDeveloperSetup
                      ? 'Google sign-in needs a one-time app setup before you can connect your account.'
                      : 'Google sign-in is not configured in this app build. Install the latest official release, or continue with local notes.'}
              </p>
              {!account && accountError && (
                <button
                  onClick={() => {
                    setMessage('');
                    void reload().catch((error) => setMessage(String(error)));
                  }}
                >
                  Retry connection settings
                </button>
              )}
              {showDeveloperSetup && setupRequested && (
                <p className="notice" role="status">
                  This alpha has no Google OAuth client configured yet. Follow the setup links
                  below, then import the Desktop app client JSON. The button will change to Sign in
                  with Google.
                </p>
              )}
              {showDeveloperSetup && (
                <details
                  ref={setupPanel}
                  className="oauth-setup"
                  open={account !== null && !account.settings.client_id}
                >
                  <summary>Developer Google connection settings</summary>
                  {!account?.settings.client_id && (
                    <>
                      <p>
                        This development build needs a Google Desktop app client. Create it once,
                        then import its downloaded JSON file below.
                      </p>
                      <ol className="setup-instructions">
                        <li>
                          {externalLink(
                            'https://console.cloud.google.com/apis/library/drive.googleapis.com',
                            'Enable the Google Drive API',
                          )}{' '}
                          in your Google Cloud project.
                        </li>
                        <li>
                          {externalLink(
                            'https://console.cloud.google.com/auth/overview',
                            'Set up the Google consent screen',
                          )}
                          . For testing, choose External and add your account as a test user.
                          Request only <code>drive.file</code>.
                        </li>
                        <li>
                          {externalLink(
                            'https://console.cloud.google.com/auth/clients',
                            'Create a Desktop app client',
                          )}{' '}
                          and download its JSON file.
                        </li>
                      </ol>
                    </>
                  )}
                  <label className="client-import">
                    <Upload size={15} /> Import Google client JSON
                    <input
                      ref={clientImport}
                      type="file"
                      accept=".json,application/json"
                      aria-label="Import Google client JSON"
                      disabled={!native || busy}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void importClient(file);
                        event.target.value = '';
                      }}
                    />
                  </label>
                  <details className="manual-client">
                    <summary>Enter client details manually</summary>
                    <label>
                      Desktop OAuth client ID
                      <input
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        placeholder="…apps.googleusercontent.com"
                        disabled={!native || busy}
                      />
                    </label>
                    <label>
                      Desktop client secret <span className="muted">(if supplied by Google)</span>
                      <input
                        value={clientSecret}
                        onChange={(e) => setClientSecret(e.target.value)}
                        autoComplete="off"
                        disabled={!native || busy}
                      />
                    </label>
                  </details>
                </details>
              )}
            </>
          ) : (
            <>
              <div className="setting-row">
                <span className="connected-dot">
                  <Cloud size={16} /> Google Drive connected
                </span>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await call('disconnect_drive');
                    })
                  }
                >
                  Disconnect
                </button>
              </div>
              {externalLink('https://drive.google.com/', 'Open Google Drive')}
              {!account.encrypted && (
                <div className="vault-choice">
                  <p>Is this a new notebook, or did you sync it on another device?</p>
                  <div className="button-row">
                    <button
                      className={!restoring ? 'active' : ''}
                      disabled={busy}
                      onClick={() => setRestoring(false)}
                    >
                      Set up this notebook
                    </button>
                    <button
                      className={restoring ? 'active' : ''}
                      disabled={busy}
                      onClick={() => setRestoring(true)}
                    >
                      Restore from Drive
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      )}
      {!restoring && (
        <section className="settings-section">
          <h3>
            {provider === 'google' && <span className="setup-number">2</span>}
            <LockKeyhole size={18} /> Protect your notes
          </h3>
          {recoveryKey ? (
            <div className="recovery-box">
              <strong>Save your recovery key somewhere safe.</strong>
              <p>It can unlock all encrypted notes. It won’t be shown again.</p>
              <code>{recoveryKey}</code>
              <div className="button-row">
                <button
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(recoveryKey)
                      .then(() => setMessage('Recovery key copied.'))
                  }
                >
                  Copy recovery key
                </button>
                <button
                  className="primary"
                  onClick={() => {
                    setRecoveryKey('');
                    setMessage('Encryption is ready.');
                  }}
                >
                  I have saved it
                </button>
              </div>
            </div>
          ) : !account?.encrypted ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (passphrase !== confirm) {
                  setMessage('The passphrases do not match.');
                  return;
                }
                void run(async () => {
                  const key = await call<string>('configure_encryption', { passphrase, remember });
                  setRecoveryKey(key);
                  setPassphrase('');
                  setConfirm('');
                });
              }}
            >
              <p>
                Choose a separate vault passphrase. Your Google password is never used for
                encryption.
              </p>
              <label>
                Vault passphrase
                <input
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  minLength={12}
                  disabled={!native || busy}
                />
              </label>
              <label>
                Confirm passphrase
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  disabled={!native || busy}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember the key in this device’s credential store
              </label>
              <button
                className="primary"
                disabled={!native || busy || passphrase.length < 12 || !confirm}
              >
                Set up encryption
              </button>
            </form>
          ) : account.unlocked ? (
            <div className="setting-row">
              <span className="connected-dot">Sync encryption unlocked</span>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await call('lock_sync');
                  })
                }
              >
                Lock and forget saved key
              </button>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await call('unlock_sync', { secret, recovery: recoveryMode, remember });
                  setSecret('');
                });
              }}
            >
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={recoveryMode}
                  onChange={(e) => setRecoveryMode(e.target.checked)}
                />
                Use a recovery key
              </label>
              <label>
                {recoveryMode ? 'Recovery key' : 'Vault passphrase'}
                <input
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember on this device
              </label>
              <button className="primary" disabled={busy || !secret}>
                <KeyRound size={16} /> Unlock sync
              </button>
            </form>
          )}
        </section>
      )}
      {restoring && account?.connected && !account.encrypted && (
        <section className="settings-section">
          <h3>Restore an existing Drive vault</h3>
          <p>Use an empty local folder and the same registered OAuth app as your other devices.</p>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setRemoteVaults(await call<RemoteVault[]>('discover_vaults'));
              })
            }
          >
            Find my vaults
          </button>
          {remoteVaults.length > 0 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await call('join_remote_vault', {
                    rootId: remoteId,
                    secret,
                    recovery: recoveryMode,
                    remember,
                  });
                  setSecret('');
                  setRestoring(false);
                  setMessage('Vault connected. Close Settings and sync to restore your notes.');
                });
              }}
            >
              <label>
                Drive vault
                <select value={remoteId} onChange={(e) => setRemoteId(e.target.value)}>
                  <option value="">Choose a vault</option>
                  {remoteVaults.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={recoveryMode}
                  onChange={(e) => setRecoveryMode(e.target.checked)}
                />
                Use a recovery key
              </label>
              <label>
                {recoveryMode ? 'Recovery key' : 'Vault passphrase'}
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <button className="primary" disabled={busy || !remoteId || !secret}>
                Connect existing vault
              </button>
            </form>
          )}
        </section>
      )}
      {provider === 'google' && (
        <section className="settings-section">
          <h3>
            <span className="setup-number">3</span> Start syncing
          </h3>
          <p>
            {syncing
              ? 'Sync is running. You can keep using your local notes.'
              : account?.connected && account.unlocked
                ? 'Ready. Local changes sync automatically. Drive is checked every 30 seconds for changes from other devices.'
                : 'Connect Google Drive and unlock encryption to start syncing.'}
          </p>
          {syncing && (
            <div className="sync-progress" role="status" aria-live="polite">
              <p>{syncProgressLabel(syncProgress)}</p>
              <progress
                aria-label="Google Drive sync progress"
                max={syncProgress?.total || 1}
                value={syncProgress?.total ? syncProgress.completed : undefined}
              />
            </div>
          )}
          <button
            className="primary"
            disabled={
              !native ||
              busy ||
              syncing ||
              !account?.connected ||
              !account.unlocked ||
              !!recoveryKey
            }
            onClick={() => {
              setOperation('sync');
              void run(async () => {
                const status = await onSync();
                if (!status)
                  throw new Error(
                    'Sync did not finish. Close Settings to see the notebook status and try again.',
                  );
                setMessage(
                  status.conflicts
                    ? 'Sync finished with conflicts. Close Settings to review both versions.'
                    : status.pending
                      ? 'Some changes are still waiting to sync. Your local work is saved.'
                      : 'Your notebook is synced with Google Drive.',
                );
              });
            }}
          >
            <Cloud size={16} /> {busy && operation === 'sync' ? 'Syncing…' : 'Sync now'}
          </button>
        </section>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <p className="small muted">
        No note content is sent to an AI service. There is no application server or telemetry.
      </p>
    </div>
  );
}
