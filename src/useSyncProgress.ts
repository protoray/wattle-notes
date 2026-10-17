import { useEffect, useState } from 'react';
import { call, native } from './api';
import type { SyncProgress } from './types';

export function syncProgressLabel(progress: SyncProgress | null) {
  if (!progress) return 'Syncing with Google Drive…';
  return progress.total > 0
    ? `${progress.stage}: ${progress.completed} of ${progress.total}`
    : `${progress.stage}…`;
}

export function useSyncProgress(active: boolean) {
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  useEffect(() => {
    if (!native || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setProgress(null);
    const poll = async () => {
      try {
        const next = await call<SyncProgress | null>('sync_progress');
        if (!cancelled) setProgress(next);
      } catch {
        // The sync command owns error reporting. A missed progress poll is harmless.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 750);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active]);
  return active ? progress : null;
}
