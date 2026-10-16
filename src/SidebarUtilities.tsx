import { useId, useState } from 'react';
import { ChevronDown, Cloud, History, Moon, Palette, Settings, Sun } from 'lucide-react';
import type { AccountInfo } from './types';
import './sidebar-utilities.css';

const preferenceKey = 'wattle-notes.sidebar.utilities-expanded';

function readExpanded(): boolean {
  try {
    return localStorage.getItem(preferenceKey) === 'true';
  } catch {
    return false;
  }
}

export interface SidebarUtilitiesProps {
  account: AccountInfo | null;
  native: boolean;
  dark: boolean;
  updateAvailable: boolean;
  onToggleDark: () => void;
  onGoogle: () => void;
  onNextcloud: () => void;
  onHistory: () => void;
  onSettings: () => void;
  onAppearance: () => void;
}

export default function SidebarUtilities({
  account,
  native,
  dark,
  updateAvailable,
  onToggleDark,
  onGoogle,
  onNextcloud,
  onHistory,
  onSettings,
  onAppearance,
}: SidebarUtilitiesProps) {
  const [expanded, setExpanded] = useState(readExpanded);
  const controlsId = useId();

  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    try {
      localStorage.setItem(preferenceKey, String(next));
    } catch {
      // The disclosure remains usable when device storage is unavailable or full.
    }
  }

  return (
    <div className="sidebar-bottom sidebar-utilities">
      <div className="sidebar-utilities-heading">
        <button
          type="button"
          className="sidebar-action sidebar-utilities-disclosure"
          aria-expanded={expanded}
          aria-controls={controlsId}
          onClick={toggleExpanded}
        >
          <Settings size={17} aria-hidden="true" />
          <span>Settings &amp; tools</span>
          <ChevronDown size={14} className="sidebar-utilities-chevron" aria-hidden="true" />
        </button>
        {updateAvailable && (
          <button
            type="button"
            className="sidebar-utilities-update"
            aria-label="Update available · Settings"
            onClick={onSettings}
          >
            Update available
          </button>
        )}
      </div>
      <div id={controlsId} className="sidebar-utilities-controls" hidden={!expanded}>
        <button type="button" className="sidebar-action" onClick={onGoogle}>
          <Cloud size={17} aria-hidden="true" />
          <span>Google Drive</span>
          <small>
            {account?.connected ? (account.unlocked ? 'Connected' : 'Locked') : 'Connect'}
          </small>
        </button>
        <button type="button" className="sidebar-action" onClick={onNextcloud}>
          <Cloud size={17} aria-hidden="true" />
          <span>Nextcloud backup</span>
        </button>
        <button type="button" className="sidebar-action" onClick={onHistory}>
          <History size={17} aria-hidden="true" />
          <span>History &amp; trash</span>
        </button>
        <button type="button" className="sidebar-action" onClick={onSettings}>
          <Settings size={17} aria-hidden="true" />
          <span>Settings</span>
        </button>
        <button type="button" className="sidebar-action" onClick={onAppearance}>
          <Palette size={17} aria-hidden="true" />
          <span>Appearance</span>
        </button>
        <button
          type="button"
          className="sidebar-action theme-toggle"
          role="switch"
          aria-checked={dark}
          aria-label="Dark mode"
          onClick={onToggleDark}
        >
          {dark ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
          <span>Dark mode</span>
          <span className="theme-switch-track" aria-hidden="true" />
        </button>
      </div>
      <div className="local-caption">
        <span className="status-dot" aria-hidden="true" />
        {native ? 'Saved on this device' : 'Preview · session only'}
      </div>
    </div>
  );
}
