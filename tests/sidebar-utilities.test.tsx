import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SidebarUtilities, { type SidebarUtilitiesProps } from '../src/SidebarUtilities';

const preferenceKey = 'wattle-notes.sidebar.utilities-expanded';

function props(overrides: Partial<SidebarUtilitiesProps> = {}): SidebarUtilitiesProps {
  return {
    account: null,
    native: true,
    dark: false,
    updateAvailable: false,
    onToggleDark: vi.fn(),
    onGoogle: vi.fn(),
    onNextcloud: vi.fn(),
    onHistory: vi.fn(),
    onSettings: vi.fn(),
    onAppearance: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Sidebar utilities', () => {
  it('starts collapsed, keeps save status visible, and expands from the keyboard', async () => {
    render(<SidebarUtilities {...props()} />);
    const user = userEvent.setup();
    const disclosure = screen.getByRole('button', { name: 'Settings & tools' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Saved on this device')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'History & trash' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Dark mode' })).toBeNull();
    await user.tab();
    expect(document.activeElement).toBe(disclosure);
    await user.keyboard('{Enter}');
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'History & trash' })).toBeTruthy();
    expect(document.getElementById(disclosure.getAttribute('aria-controls')!)?.hidden).toBe(false);
    await user.keyboard(' ');
    expect(screen.queryByRole('button', { name: 'History & trash' })).toBeNull();
    expect(document.activeElement).toBe(disclosure);
  });

  it('remembers the disclosure preference across mounts and persists collapsing', async () => {
    const user = userEvent.setup();
    const first = render(<SidebarUtilities {...props()} />);
    await user.click(screen.getByRole('button', { name: 'Settings & tools' }));
    expect(localStorage.getItem(preferenceKey)).toBe('true');
    first.unmount();
    render(<SidebarUtilities {...props()} />);
    expect(
      screen.getByRole('button', { name: 'Settings & tools' }).getAttribute('aria-expanded'),
    ).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Settings & tools' }));
    expect(localStorage.getItem(preferenceKey)).toBe('false');
  });

  it('ignores invalid preferences and remains usable if storage reads or writes fail', async () => {
    localStorage.setItem(preferenceKey, 'invalid');
    const first = render(<SidebarUtilities {...props()} />);
    expect(
      screen.getByRole('button', { name: 'Settings & tools' }).getAttribute('aria-expanded'),
    ).toBe('false');
    first.unmount();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Unavailable');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Unavailable');
    });
    render(<SidebarUtilities {...props()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Settings & tools' }));
    expect(screen.getByRole('button', { name: 'History & trash' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Settings & tools' }));
    expect(screen.queryByRole('button', { name: 'History & trash' })).toBeNull();
  });

  it('keeps an actionable update indication available while collapsed', async () => {
    const options = props({ updateAvailable: true, native: false });
    render(<SidebarUtilities {...options} />);
    expect(screen.getByText('Preview · session only')).toBeTruthy();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Update available · Settings' }));
    expect(options.onSettings).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('button', { name: 'Settings & tools' }).getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('delegates each utility and exposes the existing dark mode switch state', async () => {
    localStorage.setItem(preferenceKey, 'true');
    const options = props({ dark: true });
    const { rerender } = render(<SidebarUtilities {...options} />);
    const user = userEvent.setup();
    for (const [label, callback] of [
      ['Google Drive Connect', options.onGoogle],
      ['Nextcloud backup', options.onNextcloud],
      ['History & trash', options.onHistory],
      ['Settings', options.onSettings],
      ['Appearance', options.onAppearance],
    ] as const) {
      await user.click(screen.getByRole('button', { name: label }));
      expect(callback).toHaveBeenCalledOnce();
    }
    const toggle = screen.getByRole('switch', { name: 'Dark mode' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    await user.click(toggle);
    expect(options.onToggleDark).toHaveBeenCalledOnce();
    const account = {
      encrypted: true,
      unlocked: false,
      connected: true,
      bundled_client: false,
      settings: { client_id: '', client_secret: null },
    };
    rerender(<SidebarUtilities {...options} account={account} dark={false} />);
    expect(screen.getByRole('button', { name: 'Google Drive Locked' })).toBeTruthy();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    rerender(<SidebarUtilities {...options} account={{ ...account, unlocked: true }} />);
    expect(screen.getByRole('button', { name: 'Google Drive Connected' })).toBeTruthy();
  });
});
