import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccountInfo } from '../src/types';
import { parseDesktopClient } from '../src/oauth-config';

const fixture = vi.hoisted(() => ({ account: null as AccountInfo | null, call: vi.fn() }));
vi.mock('../src/api', () => ({ native: true, call: fixture.call }));
import Settings from '../src/Settings';

beforeEach(() => {
  fixture.account = {
    connected: false,
    bundled_client: false,
    encrypted: false,
    unlocked: false,
    settings: { client_id: '123-test.apps.googleusercontent.com', client_secret: 'desktop-secret' },
  };
  fixture.call.mockReset();
  fixture.call.mockImplementation(async (command: string) => {
    if (command === 'webdav_info')
      return { settings: { url: '', username: '' }, configured: false, last_backup: null };
    if (command === 'account_info') return structuredClone(fixture.account);
    if (command === 'connect_drive') fixture.account!.connected = true;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('Desktop client import', () => {
  it('imports only Desktop client parameters and ignores supplied endpoint URLs', () => {
    expect(
      parseDesktopClient(
        JSON.stringify({
          installed: {
            client_id: '123-test.apps.googleusercontent.com',
            client_secret: 'secret',
            auth_uri: 'https://untrusted.invalid',
          },
        }),
      ),
    ).toEqual({ clientId: '123-test.apps.googleusercontent.com', clientSecret: 'secret' });
  });
  it('rejects web clients, service accounts, malformed files, and invalid IDs', () => {
    for (const value of [
      '{',
      JSON.stringify({ web: { client_id: 'test' } }),
      JSON.stringify({ type: 'service_account' }),
      JSON.stringify({ installed: { client_id: 'bad' } }),
    ]) {
      expect(() => parseDesktopClient(value)).toThrow();
    }
  });
});

describe('Drive setup', () => {
  it('shows background sync stage/counts and prevents a duplicate manual sync', async () => {
    fixture.account!.connected = true;
    fixture.account!.unlocked = true;
    const sync = vi.fn();
    render(
      <Settings
        onBackup={vi.fn()}
        onOpenRestore={vi.fn()}
        onChanged={vi.fn()}
        onSync={sync}
        syncing
        syncProgress={{ stage: 'Uploading attachments', completed: 3, total: 100 }}
      />,
    );
    await screen.findByText('Uploading attachments: 3 of 100');
    const bar = screen.getByRole('progressbar', { name: 'Google Drive sync progress' });
    expect(bar.getAttribute('max')).toBe('100');
    expect(bar.getAttribute('value')).toBe('3');
    const button = screen.getByRole('button', { name: 'Sync now' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await userEvent.setup().click(button);
    expect(sync).not.toHaveBeenCalled();
  });
  it('offers a retry instead of remaining on Loading after connection settings fail', async () => {
    fixture.call.mockRejectedValueOnce(new Error('Temporary settings failure'));
    render(
      <Settings onBackup={vi.fn()} onOpenRestore={vi.fn()} onChanged={vi.fn()} onSync={vi.fn()} />,
    );
    await screen.findByRole('button', { name: 'Google connection unavailable' });
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Retry connection settings' }));
    await screen.findByRole('button', { name: 'Sign in with Google' });
  });
  it('keeps developer client setup out of production even with notebook client settings', async () => {
    vi.stubEnv('DEV', false);
    render(
      <Settings onBackup={vi.fn()} onOpenRestore={vi.fn()} onChanged={vi.fn()} onSync={vi.fn()} />,
    );
    const button = await screen.findByRole('button', { name: 'Sign in with Google' });
    expect(screen.queryByText('Developer Google connection settings')).toBeNull();
    expect(screen.queryByLabelText('Import Google client JSON')).toBeNull();
    await userEvent.setup().click(button);
    expect(fixture.call).toHaveBeenCalledWith('connect_drive');
  });
  it('does not ask production users to create a client if a build is unconfigured', async () => {
    vi.stubEnv('DEV', false);
    fixture.account!.settings.client_id = '';
    render(
      <Settings onBackup={vi.fn()} onOpenRestore={vi.fn()} onChanged={vi.fn()} onSync={vi.fn()} />,
    );
    const button = await screen.findByRole('button', { name: 'Google sign-in unavailable' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Install the latest official release/)).toBeDefined();
    expect(screen.queryByText('Developer Google connection settings')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Create a Desktop app client' })).toBeNull();
    expect(screen.queryByLabelText('Import Google client JSON')).toBeNull();
    expect(fixture.call).not.toHaveBeenCalledWith('connect_drive');
  });
  it('never shows developer setup before account information has loaded or when loading fails', async () => {
    let rejectAccount!: (error: Error) => void;
    fixture.call.mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectAccount = reject;
        }),
    );
    render(
      <Settings onBackup={vi.fn()} onOpenRestore={vi.fn()} onChanged={vi.fn()} onSync={vi.fn()} />,
    );
    expect(screen.queryByText('Developer Google connection settings')).toBeNull();
    expect(screen.queryByLabelText('Import Google client JSON')).toBeNull();
    rejectAccount(new Error('Connection settings unavailable'));
    await screen.findByText('Error: Connection settings unavailable');
    expect(screen.queryByText('Developer Google connection settings')).toBeNull();
  });
  it('uses bundled sign-in without exposing developer configuration or rewriting notebook settings', async () => {
    fixture.account!.bundled_client = true;
    render(
      <Settings onBackup={vi.fn()} onOpenRestore={vi.fn()} onChanged={vi.fn()} onSync={vi.fn()} />,
    );
    const button = await screen.findByRole('button', { name: 'Sign in with Google' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByLabelText('Desktop OAuth client ID')).toBeNull();
    expect(screen.queryByLabelText('Import Google client JSON')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Create a Desktop app client' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Privacy Policy' }).getAttribute('href')).toBe(
      'https://wattlenotes.app/privacy/',
    );
    expect(screen.getByRole('link', { name: 'Terms of Service' }).getAttribute('href')).toBe(
      'https://wattlenotes.app/terms-of-service/',
    );
    await userEvent.setup().click(button);
    await screen.findByText(
      'Google Drive connected. Next, protect your notes or restore an existing vault.',
    );
    expect(fixture.call).toHaveBeenCalledWith('connect_drive');
    expect(fixture.call.mock.calls.some(([command]) => command === 'save_oauth_settings')).toBe(
      false,
    );
  });
  it('shows one-click sign-in for a configured client and uses the native OAuth command', async () => {
    render(
      <Settings onBackup={vi.fn()} onOpenRestore={vi.fn()} onChanged={vi.fn()} onSync={vi.fn()} />,
    );
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'Sign in with Google' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(
      screen
        .getByLabelText('Desktop OAuth client ID')
        .closest('.oauth-setup')!
        .hasAttribute('open'),
    ).toBe(false);
    await user.click(button);
    await screen.findByText(
      'Google Drive connected. Next, protect your notes or restore an existing vault.',
    );
    const commands = fixture.call.mock.calls.map(([command]) => command);
    expect(commands.indexOf('save_oauth_settings')).toBeLessThan(commands.indexOf('connect_drive'));
    expect(fixture.call).toHaveBeenCalledWith('save_oauth_settings', {
      clientId: '123-test.apps.googleusercontent.com',
      clientSecret: 'desktop-secret',
    });
  });
  it('offers a clickable setup action when the client is missing without attempting authorization', async () => {
    fixture.account!.settings.client_id = '';
    render(
      <Settings onBackup={vi.fn()} onOpenRestore={vi.fn()} onChanged={vi.fn()} onSync={vi.fn()} />,
    );
    const link = await screen.findByRole('link', { name: 'Create a Desktop app client' });
    expect(
      (screen.getByRole('button', { name: 'Set up Google sign-in' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Set up Google sign-in' }));
    await screen.findByText(/This alpha has no Google OAuth client configured yet/);
    await userEvent.setup().click(link);
    expect(fixture.call).toHaveBeenCalledWith('open_external', {
      url: 'https://console.cloud.google.com/auth/clients',
    });
    expect(fixture.call).not.toHaveBeenCalledWith('connect_drive');
  });
  it('imports the downloaded JSON without authorizing until the sign-in button is pressed', async () => {
    fixture.account!.settings.client_id = '';
    render(
      <Settings onBackup={vi.fn()} onOpenRestore={vi.fn()} onChanged={vi.fn()} onSync={vi.fn()} />,
    );
    await screen.findByRole('link', { name: 'Create a Desktop app client' });
    const text = JSON.stringify({
      installed: {
        client_id: '456-imported.apps.googleusercontent.com',
        client_secret: 'imported-secret',
      },
    });
    const file = new File([text], 'client.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => text });
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText('Import Google client JSON'), file);
    await screen.findByText('Client loaded. Select Sign in with Google to connect.');
    expect(fixture.call).not.toHaveBeenCalledWith('connect_drive');
    await user.click(screen.getByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() =>
      expect(fixture.call).toHaveBeenCalledWith('save_oauth_settings', {
        clientId: '456-imported.apps.googleusercontent.com',
        clientSecret: 'imported-secret',
      }),
    );
  });
  it('rejects oversized imports without reading or starting authorization', async () => {
    fixture.account!.settings.client_id = '';
    render(
      <Settings onBackup={vi.fn()} onOpenRestore={vi.fn()} onChanged={vi.fn()} onSync={vi.fn()} />,
    );
    await screen.findByRole('link', { name: 'Create a Desktop app client' });
    const file = new File(['x'.repeat(65537)], 'client.json', { type: 'application/json' });
    const read = vi.fn();
    Object.defineProperty(file, 'text', { value: read });
    await userEvent.setup().upload(screen.getByLabelText('Import Google client JSON'), file);
    await screen.findByText('Error: Choose a client JSON file smaller than 64 KiB.');
    expect(read).not.toHaveBeenCalled();
    expect(fixture.call).not.toHaveBeenCalledWith('connect_drive');
  });
  it('requires unlocked encryption for sync and delegates syncing through the editor flush', async () => {
    fixture.account!.connected = true;
    fixture.account!.encrypted = true;
    fixture.account!.unlocked = true;
    const sync = vi.fn(async () => ({
      state: 'synced',
      pending: 0,
      conflicts: 0,
      last_sync: null,
      message: null,
    }));
    render(
      <Settings onBackup={vi.fn()} onOpenRestore={vi.fn()} onChanged={vi.fn()} onSync={sync} />,
    );
    const button = await screen.findByRole('button', { name: 'Sync now' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    await userEvent.setup().click(button);
    await screen.findByText('Your notebook is synced with Google Drive.');
    expect(sync).toHaveBeenCalledOnce();
  });
  it('provides a separate restore path before creating a new encryption key', async () => {
    fixture.account!.connected = true;
    render(
      <Settings onBackup={vi.fn()} onOpenRestore={vi.fn()} onChanged={vi.fn()} onSync={vi.fn()} />,
    );
    await userEvent
      .setup()
      .click(await screen.findByRole('button', { name: 'Restore from Drive' }));
    expect(screen.queryByRole('button', { name: 'Set up encryption' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Find my vaults' })).toBeDefined();
    expect((screen.getByRole('button', { name: 'Sync now' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
