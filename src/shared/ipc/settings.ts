import type { Chord, KeyActionId } from '../keymap';
import type { ChannelSpecs } from './session';

export const SETTINGS_CHANNELS = {
  uiGetSettings: {
    name: 'ui:getSettings',
    does: 'The renderer reads the app-wide UI preferences.',
  },
  uiSetSettings: {
    name: 'ui:setSettings',
    does: 'The renderer saves changed app-wide UI preferences, with no sessionId because they are app-wide.',
  },
} as const satisfies ChannelSpecs;

/** Action-window tabs (§16.1). */
export type TabId = 'capture' | 'todo';

export type Theme = 'light' | 'dark';
export const isTheme = (value: unknown): value is Theme => value === 'light' || value === 'dark';

/** The user's keymap profile choice (§7.7): `auto` resolves to `mac` on macOS else `pc`; `mac`/`pc`
 *  force that profile regardless of OS (e.g. a Mac keyboard on Linux). */
export type KeymapProfileSetting = 'auto' | 'mac' | 'pc';

/**
 * Global UI preferences (§16.6) — app-wide state persisted to userData, carrying no sessionId
 * (deliberate §16.6 exception to the §6 "every payload carries sessionId" rule). `splitRatio` is
 * the terminal pane's width fraction.
 */
export interface UiSettings {
  splitRatio: number;
  lastTab: TabId;
  theme: Theme;
  /** Artifact viewer tree-pane width in px (§20.2). */
  artifactTreeWidth: number;
  /** Full-screen tree-popout width in px (§20.2); absent until set — default is 30% of the viewport. */
  artifactFullscreenTreeWidth?: number;
  /** Keyboard layout profile (§7.7); `auto` follows the OS. */
  keymapProfile: KeymapProfileSetting;
  /** Per-action chord overrides merged over the profile (§7.7); absent when none are set. */
  keymapOverrides?: Partial<Record<KeyActionId, Chord[]>>;
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  splitRatio: 0.65,
  lastTab: 'capture',
  theme: 'light',
  artifactTreeWidth: 248,
  keymapProfile: 'auto',
};

export interface UiSetSettingsMsg {
  settings: Partial<UiSettings>;
}
