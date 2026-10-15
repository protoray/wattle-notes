import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alternateTheme, applyTheme, readTheme } from '../src/themes';

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});
describe('theme preferences', () => {
  it('preserves existing light and dark preferences and ignores unknown themes', () => {
    expect(readTheme()).toBe('light');
    localStorage.setItem('new-notes-theme', 'dark');
    expect(readTheme()).toBe('dark');
    localStorage.setItem('new-notes-theme', 'light');
    expect(readTheme()).toBe('light');
    localStorage.setItem('new-notes-theme', 'removed-theme');
    expect(readTheme()).toBe('light');
  });
  it('remembers separate light and dark choices for the sidebar switch', () => {
    applyTheme('sepia');
    expect(alternateTheme('sepia')).toBe('dark');
    applyTheme('midnight');
    expect(readTheme()).toBe('midnight');
    expect(document.documentElement.dataset.theme).toBe('midnight');
    expect(alternateTheme('midnight')).toBe('sepia');
    applyTheme('sepia');
    expect(alternateTheme('sepia')).toBe('midnight');
  });
  it('ignores an invalid or wrong-mode saved alternative', () => {
    localStorage.setItem('new-notes-dark-theme', 'sepia');
    localStorage.setItem('new-notes-light-theme', 'unavailable');
    expect(alternateTheme('light')).toBe('dark');
    expect(alternateTheme('forest')).toBe('light');
  });
  it('allows switching themes when preference storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('unavailable');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('unavailable');
    });
    expect(readTheme()).toBe('light');
    expect(() => applyTheme('forest')).not.toThrow();
    expect(document.documentElement.dataset.theme).toBe('forest');
    expect(alternateTheme('forest')).toBe('light');
  });
});
