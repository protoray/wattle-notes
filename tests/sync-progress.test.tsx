import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SyncProgress } from '../src/types';

const fixture = vi.hoisted(() => ({ native: true, call: vi.fn() }));
vi.mock('../src/api', () => ({
  get native() {
    return fixture.native;
  },
  call: fixture.call,
}));
import { syncProgressLabel, useSyncProgress } from '../src/useSyncProgress';

beforeEach(() => {
  fixture.native = true;
  fixture.call.mockReset();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('keeps one progress request in flight and stops polling after sync ends', async () => {
  let resolve!: (progress: SyncProgress | null) => void;
  fixture.call.mockReturnValue(
    new Promise<SyncProgress | null>((done) => {
      resolve = done;
    }),
  );
  const hook = renderHook(({ active }) => useSyncProgress(active), {
    initialProps: { active: true },
  });
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(fixture.call).toHaveBeenCalledExactlyOnceWith('sync_progress');
  await act(async () => resolve({ stage: 'Uploading attachments', completed: 3, total: 100 }));
  expect(syncProgressLabel(hook.result.current)).toBe('Uploading attachments: 3 of 100');
  hook.rerender({ active: false });
  expect(hook.result.current).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(fixture.call).toHaveBeenCalledTimes(1);
});

it('does not contact the native backend from a browser preview', async () => {
  fixture.native = false;
  renderHook(() => useSyncProgress(true));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(fixture.call).not.toHaveBeenCalled();
});

it('describes discovery phases without inventing a percentage', () => {
  expect(
    syncProgressLabel({ stage: 'Checking Google Drive folders', completed: 0, total: 0 }),
  ).toBe('Checking Google Drive folders…');
});
