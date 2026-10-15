import { useEffect, useState } from 'react';
import { call } from './api';
import { replaceBody, splitContent } from './content';
import type { Conflict, Revision } from './types';
export default function ConflictView({ onChanged }: { onChanged: (item: string) => void }) {
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [selected, setSelected] = useState<Conflict | null>(null);
  const [version, setVersion] = useState<Revision | null>(null);
  const [draft, setDraft] = useState('');
  const [path, setPath] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void call<Conflict[]>('conflicts')
      .then(setConflicts)
      .catch((e) => setMessage(String(e)));
  }, []);
  function choose(conflict: Conflict, revision: Revision) {
    setSelected(conflict);
    setVersion(revision);
    setDraft(splitContent(revision.content ?? '').body);
    setPath(revision.path);
  }
  async function resolve(keepBoth = false) {
    if (!selected || !version) return;
    setBusy(true);
    try {
      if (keepBoth)
        await call('keep_both_attachments', { item: selected.item_id, primary: version.id, path });
      else
        await call('resolve_conflict', {
          item: selected.item_id,
          path,
          content: version.deleted ? null : replaceBody(version.content ?? '', draft),
          version: version.id,
        });
      setConflicts(await call<Conflict[]>('conflicts'));
      setSelected(null);
      setVersion(null);
      onChanged(selected.item_id);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="conflict-view">
      <p className="muted">
        Both versions remain in history. Choose a version, or edit the combined text before
        resolving.
      </p>
      {!conflicts.length && (
        <div className="empty-panel">No conflicts. Your notes are in agreement.</div>
      )}
      {conflicts.map((c) => (
        <div className="conflict-card" key={c.item_id}>
          <strong>{c.path}</strong>
          <p>{c.reason}</p>
          <div className="button-row">
            {c.versions.map((r, i) => (
              <button
                className={version?.id === r.id ? 'active' : ''}
                key={r.id}
                onClick={() => choose(c, r)}
              >
                {r.deleted ? 'Deletion' : `Version ${i + 1}`}
              </button>
            ))}
          </div>
        </div>
      ))}
      {selected && version && (
        <>
          <label>
            Resolved filename
            <input value={path} onChange={(e) => setPath(e.target.value)} />
          </label>
          <div className="version-comparison">
            {selected.versions
              .filter((r) => !r.deleted)
              .map((r, i) => (
                <div key={r.id}>
                  <h4>Version {i + 1}</h4>
                  <pre>{splitContent(r.content ?? 'Binary attachment').body}</pre>
                </div>
              ))}
          </div>
          {version.kind === 'note' && !version.deleted && (
            <label>
              Combined Markdown
              <textarea
                className="merge-editor"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            </label>
          )}
          <button className="primary" disabled={busy} onClick={() => void resolve()}>
            {version.deleted ? 'Confirm deletion' : 'Save resolution'}
          </button>
          {version.kind === 'attachment' && !version.deleted && (
            <button disabled={busy} onClick={() => void resolve(true)}>
              Keep both files
            </button>
          )}
        </>
      )}
      {message && (
        <p className="notice" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
