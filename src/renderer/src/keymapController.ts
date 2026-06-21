// Active-keymap holder (§7.7): resolves the user's profile setting against the host OS into a live
// Keymap, persists profile changes, and re-resolves in place so the terminal's key dispatch (and any
// settings UI) always reads the current bindings. Per-key overrides arrive in a later slice.

import { resolveKeymap, type Chord, type KeyActionId, type Keymap, type KeymapProfile } from '../../shared/keymap';
import type { KeymapProfileSetting, OsPlatform } from '../../shared/ipc';

type Overrides = Partial<Record<KeyActionId, Chord[]>>;

export interface KeymapController {
  /** The currently-active resolved keymap (read per keydown by the dispatch). */
  current(): Keymap;
  profile(): KeymapProfileSetting;
  overrides(): Overrides;
  /** Switch profile: re-resolve, persist, and notify. */
  setProfile(p: KeymapProfileSetting): void;
  /** Rebind one action's chords: merge, re-resolve, persist the overrides, and notify (§7.7). */
  setOverride(action: KeyActionId, chords: Chord[]): void;
}

/** The concrete base profile a setting resolves to: `auto` follows the OS, `mac`/`pc` force it. */
export function resolveBase(profile: KeymapProfileSetting, platform: OsPlatform): KeymapProfile {
  if (profile === 'mac' || profile === 'pc') return profile;
  return platform === 'darwin' ? 'mac' : 'pc';
}

export function createKeymapController(deps: {
  platform: OsPlatform;
  initial: KeymapProfileSetting;
  persist: (p: KeymapProfileSetting) => void;
  initialOverrides?: Overrides;
  persistOverrides?: (o: Overrides) => void;
  onChange?: () => void;
}): KeymapController {
  let profile = deps.initial;
  let overrides: Overrides = { ...deps.initialOverrides };
  let keymap = resolveKeymap(resolveBase(profile, deps.platform), overrides);
  const reresolve = (): void => {
    keymap = resolveKeymap(resolveBase(profile, deps.platform), overrides);
    deps.onChange?.();
  };
  return {
    current: () => keymap,
    profile: () => profile,
    overrides: () => ({ ...overrides }),
    setProfile: (p) => {
      profile = p;
      reresolve();
      deps.persist(p);
    },
    setOverride: (action, chords) => {
      overrides = { ...overrides, [action]: chords };
      reresolve();
      deps.persistOverrides?.(overrides);
    },
  };
}
