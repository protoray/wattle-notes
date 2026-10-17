import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FolderTrash from '../src/FolderTrash';

const fixture = vi.hoisted(() => ({ restore: vi.fn() }));
vi.mock('../src/api', () => ({
  call: async (command: string, args: Record<string, unknown> = {}) => {
    if (command === 'deleted_folders') return [{ id: 'deleted', path: 'Work', deleted_at: 1 }];
    if (command === 'restore_folder') return fixture.restore(args.id);
    throw new Error(`Unexpected command ${command}`);
  },
}));
afterEach(cleanup);
beforeEach(() => {
  fixture.restore.mockReset();
});

it('restores the entire notebook and refreshes navigation', async () => {
  const onRestored = vi.fn().mockResolvedValue(undefined);
  render(<FolderTrash onRestored={onRestored} syncing={false} />);
  await userEvent
    .setup()
    .click(await screen.findByRole('button', { name: 'Restore notebook Work' }));
  await screen.findByText('Notebook restored.');
  expect(fixture.restore).toHaveBeenCalledWith('deleted');
  expect(onRestored).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Restore notebook Work' })).toBeNull();
});

it('keeps a recoverable entry when restoration refuses an overwrite', async () => {
  fixture.restore.mockRejectedValue(new Error('A folder already exists'));
  const onRestored = vi.fn();
  const { rerender } = render(<FolderTrash onRestored={onRestored} syncing />);
  const button = await screen.findByRole('button', { name: 'Restore notebook Work' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  rerender(<FolderTrash onRestored={onRestored} syncing={false} />);
  await userEvent.setup().click(button);
  await screen.findByText('Error: A folder already exists');
  expect(onRestored).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Restore notebook Work' })).toBeTruthy();
});
