import { useEffect, useState } from 'react';
import { call, native } from './api';
import { splitContent } from './content';
import type { Revision } from './types';
export default function HistoryView({
  item,
  onChanged,
}: {
  item: string | null;
  onChanged: (item: string) => void;
}) {
  const [history, setHistory] = useState<Revision[]>([]);
  const [selected, setSelected] = useState<Revision | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    void call<Revision[]>('history', { item })
      .then((items) => setHistory(items.reverse()))
      .catch((e) => setMessage(String(e)));
  }, [item]);
  async function restore() {
    if (!selected) return;
    try {
      await call('restore_revision', { id: selected.id });
      setMessage('Saved version restored.');
      onChanged(selected.item_id);
    } catch (e) {
      setMessage(String(e));
    }
  }
  return (
    <div className="history-view">
      <p className="muted">
        Saved versions and deleted notes are retained. Restoring creates a new version.
      </p>
      {!history.length && (
        <div className="empty-panel">
          {native ? 'No saved versions yet.' : 'History is available in the desktop app.'}
        </div>
      )}
      <div className="history-layout">
        <div className="history-list">
          {history.map((r, i) => (
            <button
              className={selected?.id === r.id ? 'active' : ''}
              key={r.id}
              onClick={() => setSelected(r)}
            >
              <strong>{r.path}</strong>
              <span>{r.deleted ? 'Deleted' : `Saved version ${history.length - i}`}</span>
            </button>
          ))}
        </div>
        {selected && (
          <div className="history-detail">
            <h3>{selected.path}</h3>
            <pre>
              {
                splitContent(
                  selected.content ??
                    (selected.deleted ? 'This version records a deletion.' : 'Attachment version'),
                ).body
              }
            </pre>
            <button className="primary" disabled={selected.deleted} onClick={() => void restore()}>
              Restore this version
            </button>
          </div>
        )}
      </div>
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
