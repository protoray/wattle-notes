import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WebDavInfo } from '../src/NextcloudBackup';
const fixture = vi.hoisted(() => ({
  info: null as WebDavInfo | null,
  call: vi.fn(),
  folder: vi.fn(),
}));
vi.mock('../src/api', () => ({ native: true, call: fixture.call }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: fixture.folder }));
import NextcloudBackup from '../src/NextcloudBackup';
beforeEach(() => {
  fixture.info = {
    settings: { url: 'https://cloud.example.test/remote.php/dav/files/user/', username: 'user' },
    configured: false,
    last_backup: null,
  };
  fixture.call.mockReset();
  fixture.folder.mockReset();
  fixture.call.mockImplementation(async (command: string) => {
    if (command === 'webdav_info') return structuredClone(fixture.info);
    if (command === 'configure_webdav') fixture.info!.configured = true;
    if (command === 'list_webdav_backups') return [{ name: '123-test.wnbackup', size: 1024 }];
    if (command === 'restore_webdav_backup') return '/test/restored';
  });
});
afterEach(cleanup);
describe('Nextcloud encrypted backup controls', () => {
  it('tests and saves a connection without Google authorization and clears the app password', async () => {
    render(<NextcloudBackup unlocked={false} onBackup={vi.fn()} onOpenRestore={vi.fn()} />);
    const user = userEvent.setup();
    await waitFor(() =>
      expect((screen.getByLabelText('Nextcloud username') as HTMLInputElement).value).toBe('user'),
    );
    await user.type(screen.getByLabelText('Nextcloud app password'), 'synthetic-app-password');
    await user.click(screen.getByRole('button', { name: 'Save & test connection' }));
    await screen.findByText('Nextcloud connected. You can now back up or restore.');
    expect(fixture.call).toHaveBeenCalledWith('configure_webdav', {
      url: fixture.info!.settings.url,
      username: 'user',
      password: 'synthetic-app-password',
    });
    expect((screen.getByLabelText('Nextcloud app password') as HTMLInputElement).value).toBe('');
    expect(fixture.call).not.toHaveBeenCalledWith('connect_drive');
  });
  it('requires unlocked encryption and uses the editor-aware backup callback', async () => {
    fixture.info!.configured = true;
    const backup = vi.fn(async () => '123-test.wnbackup');
    const props = { onBackup: backup, onOpenRestore: vi.fn() };
    const view = render(<NextcloudBackup unlocked={false} {...props} />);
    const button = await screen.findByRole('button', { name: 'Back up now' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<NextcloudBackup unlocked {...props} />);
    await userEvent.setup().click(button);
    await screen.findByText('Encrypted backup saved to Nextcloud.');
    expect(backup).toHaveBeenCalledOnce();
  });
  it('restores with the selected backup secret into a separate location before opening it', async () => {
    fixture.info!.configured = true;
    fixture.folder.mockResolvedValue('/test/parent');
    const opened = vi.fn(async () => {});
    render(<NextcloudBackup unlocked={false} onBackup={vi.fn()} onOpenRestore={opened} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Find backups' }));
    await user.selectOptions(
      await screen.findByLabelText('Backup to restore'),
      '123-test.wnbackup',
    );
    await user.type(screen.getByLabelText('Backup passphrase'), 'synthetic-backup-passphrase');
    await user.click(screen.getByRole('button', { name: 'Restore backup to a new folder' }));
    await screen.findByText(/Backup restored to/);
    expect(fixture.call).toHaveBeenCalledWith('restore_webdav_backup', {
      name: '123-test.wnbackup',
      parent: '/test/parent',
      secret: 'synthetic-backup-passphrase',
      recovery: false,
    });
    expect(opened).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Open restored notebook' }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith('/test/restored'));
  });
  it('reports a failed backup without claiming success', async () => {
    fixture.info!.configured = true;
    render(
      <NextcloudBackup
        unlocked
        onBackup={vi.fn(async () => {
          throw new Error('Nextcloud storage is full');
        })}
        onOpenRestore={vi.fn()}
      />,
    );
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Back up now' }));
    await screen.findByText('Error: Nextcloud storage is full');
    expect(screen.queryByText('Encrypted backup saved to Nextcloud.')).toBeNull();
  });
});
