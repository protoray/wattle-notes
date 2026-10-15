export const themes = [
  { id: 'light', name: 'Paper', description: 'Soft white, sage accents', dark: false },
  { id: 'dark', name: 'Charcoal', description: 'Neutral grey, quiet contrast', dark: true },
  { id: 'midnight', name: 'Midnight', description: 'Deep blue, cool accents', dark: true },
  { id: 'sepia', name: 'Sepia', description: 'Warm paper, amber accents', dark: false },
  { id: 'forest', name: 'Forest', description: 'The original green dark theme', dark: true },
] as const;
export type ThemeId = (typeof themes)[number]['id'];

function isTheme(value: string | null): value is ThemeId {
  return themes.some((theme) => theme.id === value);
}
export function isDarkTheme(theme: ThemeId): boolean {
  return themes.find((option) => option.id === theme)!.dark;
}
export function readTheme(): ThemeId {
  try {
    const stored = localStorage.getItem('new-notes-theme');
    return isTheme(stored) ? stored : 'light';
  } catch {
    return 'light';
  }
}
export function applyTheme(theme: ThemeId) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('new-notes-theme', theme);
    localStorage.setItem(
      isDarkTheme(theme) ? 'new-notes-dark-theme' : 'new-notes-light-theme',
      theme,
    );
  } catch {
    // The chosen theme still works for this session if preference storage is unavailable.
  }
}
export function alternateTheme(theme: ThemeId): ThemeId {
  const dark = isDarkTheme(theme);
  try {
    const preferred = localStorage.getItem(dark ? 'new-notes-light-theme' : 'new-notes-dark-theme');
    if (isTheme(preferred) && isDarkTheme(preferred) !== dark) return preferred;
  } catch {
    // Use the default for the opposite mode.
  }
  return dark ? 'light' : 'dark';
}
