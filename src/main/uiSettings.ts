// Global UI-settings store (§16.6). A missing/corrupt/garbage file MUST degrade to
// defaults, never throw, so a bad pref can never wedge startup.

import { readFileSync } from 'node:fs';
import { atomicWriteFileSync } from './atomicFile';
import { DEFAULT_UI_SETTINGS, isTheme, type KeymapProfileSetting, type TabId, type Theme, type UiSettings } from '../shared/ipc';
import { KEY_ACTION_IDS, type Chord, type KeyActionId } from '../shared/keymap';
import { isRecord } from './yamlRecord';

// §16.6: the store must never hand back a 0/1 ratio (the renderer adds a px-based clamp).
const MIN_RATIO = 0.05;
const MAX_RATIO = 0.95;
// Artifact tree-pane width clamp (§20.2).
const MIN_TREE_W = 140;
const MAX_TREE_W = 640;
const MIN_FS_TREE_W = 200;
const MAX_FS_TREE_W = 2000;

export interface UiSettingsStore {
  get(): UiSettings;
  /** Merge a partial over current, persist, and return the new settings. */
  set(patch: Partial<UiSettings>): UiSettings;
}

function coerceRatio(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, raw));
}

function coerceWidth(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(MAX_TREE_W, Math.max(MIN_TREE_W, Math.round(raw)));
}

// Stays undefined so the renderer can apply its viewport-relative default (§20.2).
function coerceFsWidth(raw: unknown, fallback: number | undefined): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(MAX_FS_TREE_W, Math.max(MIN_FS_TREE_W, Math.round(raw)));
}

function coerceTab(raw: unknown, fallback: TabId): TabId {
  return raw === 'capture' || raw === 'todo' ? raw : fallback;
}

function coerceTheme(raw: unknown, fallback: Theme): Theme {
  return isTheme(raw) ? raw : fallback;
}

function coerceKeymapProfile(raw: unknown, fallback: KeymapProfileSetting): KeymapProfileSetting {
  return raw === 'auto' || raw === 'mac' || raw === 'pc' ? raw : fallback;
}

function coerceBoolean(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback;
}

function coerceChord(raw: unknown): Chord | null {
  if (!isRecord(raw) || typeof raw.key !== 'string') return null;
  const c: Chord = { key: raw.key };
  if (raw.ctrl === true) c.ctrl = true;
  if (raw.alt === true) c.alt = true;
  if (raw.shift === true) c.shift = true;
  if (raw.meta === true) c.meta = true;
  return c;
}

/** Keep only known actions mapped to non-empty arrays of well-formed chords (§7.7); return undefined
 *  when nothing valid remains so the field is omitted rather than persisted empty/garbage. */
function coerceKeymapOverrides(raw: unknown): Partial<Record<KeyActionId, Chord[]>> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Partial<Record<KeyActionId, Chord[]>> = {};
  for (const action of KEY_ACTION_IDS) {
    const v = raw[action];
    if (!Array.isArray(v)) continue;
    const chords = v.map(coerceChord).filter((c): c is Chord => c !== null);
    if (chords.length > 0) out[action] = chords;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Validate each field independently against `base`, so one bad field can't poison the rest. */
function coerce(raw: unknown, base: UiSettings): UiSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: UiSettings = {
    splitRatio: coerceRatio(r.splitRatio, base.splitRatio),
    lastTab: coerceTab(r.lastTab, base.lastTab),
    theme: coerceTheme(r.theme, base.theme),
    artifactTreeWidth: coerceWidth(r.artifactTreeWidth, base.artifactTreeWidth),
    keymapProfile: coerceKeymapProfile(r.keymapProfile, base.keymapProfile),
    showTokenCounts: coerceBoolean(r.showTokenCounts, base.showTokenCounts),
  };
  const fs = coerceFsWidth(r.artifactFullscreenTreeWidth, base.artifactFullscreenTreeWidth);
  if (fs !== undefined) out.artifactFullscreenTreeWidth = fs; // omit when unset so it never persists as null
  const overrides = coerceKeymapOverrides(r.keymapOverrides);
  if (overrides) out.keymapOverrides = overrides; // omit when none, like the fullscreen width
  return out;
}

function load(filePath: string): UiSettings {
  try {
    return coerce(JSON.parse(readFileSync(filePath, 'utf8')), DEFAULT_UI_SETTINGS);
  } catch {
    return { ...DEFAULT_UI_SETTINGS };
  }
}

function persist(filePath: string, settings: UiSettings): void {
  atomicWriteFileSync(filePath, JSON.stringify(settings));
}

export function createUiSettingsStore(filePath: string): UiSettingsStore {
  let current = load(filePath);
  return {
    get: () => ({ ...current }),
    set: (patch) => {
      current = coerce({ ...current, ...patch }, current);
      persist(filePath, current);
      return { ...current };
    },
  };
}
