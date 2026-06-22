// Global UI-settings store (§16.6). A missing/corrupt/garbage file MUST degrade to
// defaults, never throw, so a bad pref can never wedge startup.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_UI_SETTINGS, type TabId, type Theme, type UiSettings } from '../shared/ipc';

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
  return raw === 'light' || raw === 'dark' ? raw : fallback;
}

/** Validate each field independently against `base`, so one bad field can't poison the rest. */
function coerce(raw: unknown, base: UiSettings): UiSettings {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: UiSettings = {
    splitRatio: coerceRatio(r.splitRatio, base.splitRatio),
    lastTab: coerceTab(r.lastTab, base.lastTab),
    theme: coerceTheme(r.theme, base.theme),
    artifactTreeWidth: coerceWidth(r.artifactTreeWidth, base.artifactTreeWidth),
  };
  const fs = coerceFsWidth(r.artifactFullscreenTreeWidth, base.artifactFullscreenTreeWidth);
  if (fs !== undefined) out.artifactFullscreenTreeWidth = fs; // omit when unset so it never persists as null
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
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings));
  renameSync(tmp, filePath);
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
