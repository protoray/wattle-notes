import { useCallback, useEffect, useRef, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { call, native } from './api';
import { version } from '../package.json';

const preference = 'wattle-notes.check-updates';
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'saving'
  | 'installing'
  | 'restart'
  | 'error';

export function useAppUpdates(saveBeforeRestart: () => Promise<void>) {
  const [automatic, setAutomatic] = useState(() => {
    try {
      return localStorage.getItem(preference) !== 'false';
    } catch {
      return true;
    }
  });
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [available, setAvailable] = useState<{ version: string; notes: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const update = useRef<Update | null>(null);
  const running = useRef(false);
  const locked = useRef(false);
  const installed = useRef(false);
  const save = useRef(saveBeforeRestart);
  useEffect(() => {
    save.current = saveBeforeRestart;
  }, [saveBeforeRestart]);

  const checkNow = useCallback(async () => {
    if (!native || running.current || installed.current) return;
    running.current = true;
    setError('');
    setPhase('checking');
    try {
      await update.current?.close();
      update.current = null;
      setAvailable(null);
      const next = await check({ timeout: 15000 });
      update.current = next;
      setAvailable(next ? { version: next.version, notes: next.body ?? '' } : null);
      setPhase(next ? 'available' : 'current');
    } catch (cause) {
      setError(`Could not check GitHub for updates. ${String(cause)}`);
      setPhase('error');
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(() => {
    if (!native || !automatic) return;
    const timer = setTimeout(() => void checkNow(), 3000);
    return () => clearTimeout(timer);
  }, [automatic, checkNow]);

  useEffect(
    () => () => {
      void update.current?.close().catch(() => {});
    },
    [],
  );

  function changeAutomatic(enabled: boolean) {
    setAutomatic(enabled);
    try {
      localStorage.setItem(preference, String(enabled));
    } catch {
      // Updates remain usable when preferences cannot be persisted.
    }
  }

  async function install() {
    const next = update.current;
    if (!native || !next || running.current) return;
    running.current = true;
    locked.current = true;
    setError('');
    setProgress(null);
    let restarting = false;
    try {
      if (!installed.current) {
        setPhase('downloading');
        let downloaded = 0;
        let total: number | undefined;
        // Tauri verifies the signature before download() succeeds. Installation
        // is separate so a failed save can never replace/restart the app.
        await next.download(
          (event) => {
            if (event.event === 'Started') total = event.data.contentLength;
            if (event.event === 'Progress') downloaded += event.data.chunkLength;
            if (total) setProgress(Math.min(100, Math.round((downloaded / total) * 100)));
          },
          { timeout: 120000 },
        );
        setPhase('saving');
        await save.current();
        setPhase('installing');
        await next.install();
        installed.current = true;
      } else {
        setPhase('saving');
        await save.current();
      }
      setPhase('restart');
      await call('restart_after_update');
      restarting = true;
    } catch (cause) {
      setError(
        installed.current
          ? `Update installed. Close and reopen Wattle Notes if restarting fails. ${String(cause)}`
          : `Update stopped. ${String(cause)}`,
      );
      setPhase(installed.current ? 'restart' : 'error');
    } finally {
      running.current = false;
      // A successful restart request returns before the process actually exits.
      // Keep editing/quit locked until then so no new draft can be lost.
      if (!restarting) locked.current = false;
    }
  }

  return {
    version,
    phase,
    available,
    progress,
    error,
    automatic,
    changeAutomatic,
    checkNow,
    install,
    locked,
    busy:
      ['downloading', 'saving', 'installing'].includes(phase) || (phase === 'restart' && !error),
  };
}

export type AppUpdates = ReturnType<typeof useAppUpdates>;
