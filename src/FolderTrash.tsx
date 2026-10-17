import { useEffect, useState } from 'react';
import { call } from './api';
import type { DeletedFolder } from './types';

export default function FolderTrash({
  onRestored,
  syncing,
}: {
  onRestored: () => Promise<void>;
  syncing: boolean;
}) {
  const [folders, setFolders] = useState<DeletedFolder[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let cancelled = false;
    void call<DeletedFolder[]>('deleted_folders')
      .then((items) => {
        if (!cancelled) setFolders(items);
      })
      .catch((error) => {
        if (!cancelled) setMessage(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function restore(id: string) {
    if (busy || syncing) return;
    setBusy(true);
    setMessage('');
    try {
      await call('restore_folder', { id });
      setFolders((items) => items.filter((item) => item.id !== id));
      await onRestored();
      setMessage('Notebook restored.');
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Deleted notebooks">
      {folders.length > 0 && (
        <>
          <h3>Deleted notebooks</h3>
          <p className="small muted">
            Full folder copies are kept on this device, including attachments and empty
            subnotebooks.
          </p>
          {folders.map((folder) => (
            <div className="folder-trash-row" key={folder.id}>
              <span>{folder.path}</span>
              <button
                disabled={busy || syncing}
                title={syncing ? 'Wait for sync to finish before restoring' : undefined}
                aria-label={`Restore notebook ${folder.path}`}
                onClick={() => void restore(folder.id)}
              >
                Restore notebook
              </button>
            </div>
          ))}
        </>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
