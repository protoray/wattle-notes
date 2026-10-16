import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ native: true, check: vi.fn(), call: vi.fn() }));
vi.mock('../src/api', () => ({
  get native() {
    return fixture.native;
  },
  call: fixture.call,
}));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: fixture.check }));
import { useAppUpdates } from '../src/useAppUpdates';
import AppUpdatesPanel from '../src/AppUpdates';

function candidate() {
  return {
    version: '0.1.3',
    body: 'Fixes and improvements',
    close: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue(undefined),
    install: vi.fn().mockResolvedValue(undefined),
  };
}
beforeEach(() => {
  localStorage.clear();
  fixture.native = true;
  fixture.check.mockReset().mockResolvedValue(null);
  fixture.call.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('app updates', () => {
  it('checks at launch, offers the build, and never downloads without a click', async () => {
    vi.useFakeTimers();
    const next = candidate();
    fixture.check.mockResolvedValue(next);
    const { result } = renderHook(() => useAppUpdates(vi.fn()));
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(fixture.check).toHaveBeenCalledExactlyOnceWith({ timeout: 15000 });
    expect(result.current.available?.version).toBe('0.1.3');
    expect(next.download).not.toHaveBeenCalled();
  });

  it('persists opting out while retaining a manual check', async () => {
    vi.useFakeTimers();
    localStorage.setItem('wattle-notes.check-updates', 'false');
    const { result } = renderHook(() => useAppUpdates(vi.fn()));
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(fixture.check).not.toHaveBeenCalled();
    await act(() => result.current.checkNow());
    expect(result.current.phase).toBe('current');
    act(() => result.current.changeAutomatic(true));
    expect(localStorage.getItem('wattle-notes.check-updates')).toBe('true');
  });

  it('downloads and verifies, saves, installs, then restarts in that order', async () => {
    const sequence: string[] = [];
    const next = candidate();
    next.download.mockImplementation(async (progress) => {
      sequence.push('download');
      progress({ event: 'Started', data: { contentLength: 100 } });
      progress({ event: 'Progress', data: { chunkLength: 50 } });
    });
    next.install.mockImplementation(async () => {
      sequence.push('install');
    });
    fixture.call.mockImplementation(async (command) => {
      sequence.push(command);
    });
    fixture.check.mockResolvedValue(next);
    const { result } = renderHook(() =>
      useAppUpdates(async () => {
        sequence.push('save');
      }),
    );
    await act(() => result.current.checkNow());
    await act(() => result.current.install());
    expect(sequence).toEqual(['download', 'save', 'install', 'restart_after_update']);
    expect(result.current.progress).toBe(50);
  });

  it('does not install or restart if the open note cannot be saved', async () => {
    const next = candidate();
    fixture.check.mockResolvedValue(next);
    const { result } = renderHook(() =>
      useAppUpdates(async () => {
        throw new Error('Disk full');
      }),
    );
    await act(() => result.current.checkNow());
    await act(() => result.current.install());
    expect(next.install).not.toHaveBeenCalled();
    expect(fixture.call).not.toHaveBeenCalled();
    expect(result.current.error).toContain('Disk full');
    expect(result.current.locked.current).toBe(false);
  });

  it('does not save, install or restart a failed download/signature check and allows retry', async () => {
    const next = candidate();
    next.download.mockRejectedValueOnce(new Error('Signature verification failed'));
    fixture.check.mockResolvedValue(next);
    const save = vi.fn();
    const { result } = renderHook(() => useAppUpdates(save));
    await act(() => result.current.checkNow());
    await act(() => result.current.install());
    expect(save).not.toHaveBeenCalled();
    expect(next.install).not.toHaveBeenCalled();
    expect(result.current.phase).toBe('error');
    await act(() => result.current.install());
    expect(next.install).toHaveBeenCalledOnce();
  });

  it('blocks overlapping operations and keeps quit locked while the restart is pending', async () => {
    let finish!: () => void;
    const next = candidate();
    next.download.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    fixture.check.mockResolvedValue(next);
    const { result } = renderHook(() => useAppUpdates(vi.fn()));
    await act(() => result.current.checkNow());
    let install!: Promise<void>;
    act(() => {
      install = result.current.install();
    });
    expect(result.current.locked.current).toBe(true);
    expect(result.current.busy).toBe(true);
    await act(() => result.current.checkNow());
    await act(() => result.current.install());
    expect(next.download).toHaveBeenCalledOnce();
    expect(fixture.check).toHaveBeenCalledOnce();
    await act(async () => {
      finish();
      await install;
    });
    expect(result.current.locked.current).toBe(true);
    expect(result.current.busy).toBe(true);
  });

  it('retries a failed restart without installing twice', async () => {
    const next = candidate();
    fixture.check.mockResolvedValue(next);
    fixture.call.mockRejectedValueOnce(new Error('Restart failed'));
    const save = vi.fn();
    const { result } = renderHook(() => useAppUpdates(save));
    await act(() => result.current.checkNow());
    await act(() => result.current.install());
    expect(result.current.phase).toBe('restart');
    expect(result.current.locked.current).toBe(false);
    expect(result.current.busy).toBe(false);
    await act(() => result.current.install());
    expect(next.install).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('shows offline failures and lets the user check again', async () => {
    fixture.check.mockRejectedValueOnce(new Error('Offline'));
    function Panel() {
      return <AppUpdatesPanel updates={useAppUpdates(vi.fn())} />;
    }
    render(<Panel />);
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText(/Could not check GitHub/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await waitFor(() =>
      expect(screen.getByText('You have the latest build for this device.')).toBeTruthy(),
    );
  });

  it('never contacts GitHub from the browser preview', async () => {
    vi.useFakeTimers();
    fixture.native = false;
    const { result } = renderHook(() => useAppUpdates(vi.fn()));
    await act(() => vi.advanceTimersByTimeAsync(10000));
    await act(() => result.current.checkNow());
    expect(fixture.check).not.toHaveBeenCalled();
  });
});
