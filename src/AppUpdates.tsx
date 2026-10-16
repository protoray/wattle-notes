import { createPortal } from 'react-dom';
import { Download, RefreshCw } from 'lucide-react';
import { native } from './api';
import type { AppUpdates } from './useAppUpdates';

export default function AppUpdatesPanel({ updates }: { updates: AppUpdates }) {
  const { phase, available, error, busy } = updates;
  return (
    <section className="settings-section app-updates" aria-label="App updates">
      <h3>App updates</h3>
      <p className="small muted">Wattle Notes {updates.version} · Developer alpha</p>
      <label className="update-preference">
        <input
          type="checkbox"
          checked={updates.automatic}
          disabled={!native || busy}
          onChange={(event) => updates.changeAutomatic(event.target.checked)}
        />
        Check for updates when Wattle Notes opens
      </label>
      <p className="small muted">
        Checks GitHub for new alpha builds. Notes and attachments stay on this computer. You choose
        when to download, install and restart.
      </p>
      {!native && <p className="small muted">Updates are available in the desktop app.</p>}
      <div role="status" aria-live="polite">
        {phase === 'current' && <p>You have the latest build for this device.</p>}
        {phase === 'checking' && <p>Checking GitHub…</p>}
        {available && <p>Wattle Notes {available.version} is available.</p>}
        {error && <p className="notice">{error}</p>}
      </div>
      {available?.notes && (
        <details>
          <summary>What’s new</summary>
          <pre className="update-notes">{available.notes}</pre>
        </details>
      )}
      <div className="button-row">
        <button
          disabled={!native || busy || phase === 'checking' || phase === 'restart'}
          onClick={() => void updates.checkNow()}
        >
          <RefreshCw size={15} /> Check for updates
        </button>
        {available && (
          <button
            className="primary"
            disabled={busy || phase === 'checking'}
            onClick={() => void updates.install()}
          >
            <Download size={15} />
            {phase === 'restart' ? 'Restart Wattle Notes' : 'Install update and restart'}
          </button>
        )}
      </div>
    </section>
  );
}

export function UpdateProgress({ updates }: { updates: AppUpdates }) {
  if (!updates.busy) return null;
  return createPortal(
    <div
      className="update-shade"
      role="alertdialog"
      aria-modal="true"
      aria-label="Updating Wattle Notes"
    >
      <div
        className="update-progress"
        role="status"
        aria-live="polite"
        tabIndex={-1}
        ref={(node) => node?.focus()}
      >
        <h2>Updating Wattle Notes</h2>
        <p>
          {updates.phase === 'downloading'
            ? 'Downloading and verifying the update…'
            : updates.phase === 'saving'
              ? 'Saving your open note…'
              : updates.phase === 'restart'
                ? 'Restarting Wattle Notes…'
                : 'Installing the update…'}
        </p>
        {updates.phase === 'downloading' && (
          <progress aria-label="Update download" max={100} value={updates.progress ?? undefined} />
        )}
        <p className="small muted">The app will restart when it’s ready.</p>
      </div>
    </div>,
    document.body,
  );
}
