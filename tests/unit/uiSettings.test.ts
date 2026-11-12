import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_UI_SETTINGS } from '../../src/shared/ipc';
import { createUiSettingsStore } from '../../src/main/uiSettings';

describe('global UI settings store (§16.6 — first on-disk persistence, outside the repo)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ui-settings-'));
    file = join(dir, 'nested', 'ui-settings.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the spec defaults when no file exists yet', () => {
    const store = createUiSettingsStore(file);
    expect(store.get()).toEqual(DEFAULT_UI_SETTINGS);
  });

  it('persists a set and a fresh store reads it back (round-trip across restart)', () => {
    createUiSettingsStore(file).set({ splitRatio: 0.4, lastTab: 'todo' });
    expect(createUiSettingsStore(file).get()).toEqual({ splitRatio: 0.4, lastTab: 'todo', theme: 'light', artifactTreeWidth: 248, keymapProfile: 'auto', showTokenCounts: false });
  });

  it('merges a partial set, leaving untouched fields intact', () => {
    const store = createUiSettingsStore(file);
    store.set({ splitRatio: 0.5 });
    store.set({ lastTab: 'todo' });
    expect(store.get()).toEqual({ splitRatio: 0.5, lastTab: 'todo', theme: 'light', artifactTreeWidth: 248, keymapProfile: 'auto', showTokenCounts: false });
  });

  it('defaults the keymap profile to auto and round-trips a chosen one (§7.7)', () => {
    expect(createUiSettingsStore(file).get().keymapProfile).toBe('auto');
    createUiSettingsStore(file).set({ keymapProfile: 'mac' });
    expect(createUiSettingsStore(file).get().keymapProfile).toBe('mac');
  });

  it('coerces an unknown keymap profile back to auto (§7.7)', () => {
    const store = createUiSettingsStore(file);
    store.set({ keymapProfile: 'klingon' as unknown as 'auto' });
    expect(store.get().keymapProfile).toBe('auto');
  });

  it('round-trips per-action keymap overrides and drops malformed ones (§7.7)', () => {
    const store = createUiSettingsStore(file);
    store.set({ keymapOverrides: { copy: [{ key: 'k', ctrl: true }] } });
    expect(createUiSettingsStore(file).get().keymapOverrides).toEqual({ copy: [{ key: 'k', ctrl: true }] });
    // Garbage values (non-array, non-chord, unknown action) are dropped, not persisted.
    store.set({ keymapOverrides: { copy: ['nope'], bogusAction: [{ key: 'x' }] } as never });
    expect(createUiSettingsStore(file).get().keymapOverrides).toBeUndefined();
  });

  it('round-trips the theme and falls back to the default for a bogus value', () => {
    createUiSettingsStore(file).set({ theme: 'dark' });
    expect(createUiSettingsStore(file).get().theme).toBe('dark');
    const bad = join(dir, 'ui-settings.json');
    writeFileSync(bad, JSON.stringify({ theme: 'sepia' }));
    expect(createUiSettingsStore(bad).get().theme).toBe(DEFAULT_UI_SETTINGS.theme);
  });

  it('reads the "Show token counts" setting off when the file has no value for it', () => {
    const old = join(dir, 'ui-settings.json');
    writeFileSync(old, JSON.stringify({ splitRatio: 0.4, lastTab: 'todo', theme: 'dark', artifactTreeWidth: 300, keymapProfile: 'mac' }));
    expect(createUiSettingsStore(old).get().showTokenCounts).toBe(false);
  });

  it('round-trips the "Show token counts" setting across restarts, on and then off', () => {
    createUiSettingsStore(file).set({ showTokenCounts: true });
    const on = createUiSettingsStore(file).get().showTokenCounts;
    createUiSettingsStore(file).set({ showTokenCounts: false });
    expect({ on, off: createUiSettingsStore(file).get().showTokenCounts }).toEqual({ on: true, off: false });
  });

  it.each(['yes', 1, null, {}])('reads a stored non-boolean "Show token counts" setting (%j) as off', (stored) => {
    const bad = join(dir, 'ui-settings.json');
    writeFileSync(bad, JSON.stringify({ showTokenCounts: stored }));
    expect(createUiSettingsStore(bad).get().showTokenCounts).toBe(false);
  });

  it('keeps the current "Show token counts" setting when a set carries a non-boolean value', () => {
    const store = createUiSettingsStore(file);
    store.set({ showTokenCounts: true });
    store.set({ showTokenCounts: 'off' as unknown as boolean });
    expect({ live: store.get().showTokenCounts, stored: createUiSettingsStore(file).get().showTokenCounts }).toEqual({ live: true, stored: true });
  });

  it('degrades a corrupt file to defaults without throwing', () => {
    const corrupt = join(dir, 'ui-settings.json');
    writeFileSync(corrupt, 'not json {{{');
    expect(() => createUiSettingsStore(corrupt).get()).not.toThrow();
    expect(createUiSettingsStore(corrupt).get()).toEqual(DEFAULT_UI_SETTINGS);
  });

  it('rejects out-of-range or wrong-typed fields, falling back per field', () => {
    const bad = join(dir, 'ui-settings.json');
    writeFileSync(bad, JSON.stringify({ splitRatio: 'wide', lastTab: 'mystery' }));
    expect(createUiSettingsStore(bad).get()).toEqual(DEFAULT_UI_SETTINGS);
  });

  it('clamps an extreme splitRatio into a sane range', () => {
    const store = createUiSettingsStore(file);
    store.set({ splitRatio: 0.999 });
    expect(store.get().splitRatio).toBeLessThanOrEqual(0.95);
    store.set({ splitRatio: 0.0001 });
    expect(store.get().splitRatio).toBeGreaterThanOrEqual(0.05);
  });

  it('round-trips and clamps the artifact tree width', () => {
    const store = createUiSettingsStore(file);
    store.set({ artifactTreeWidth: 320 });
    expect(createUiSettingsStore(file).get().artifactTreeWidth).toBe(320);
    store.set({ artifactTreeWidth: 9999 });
    expect(store.get().artifactTreeWidth).toBeLessThanOrEqual(640);
    store.set({ artifactTreeWidth: 10 });
    expect(store.get().artifactTreeWidth).toBeGreaterThanOrEqual(140);
  });

  it('round-trips and clamps the full-screen tree width, absent by default (§20.2)', () => {
    const store = createUiSettingsStore(file);
    expect(store.get().artifactFullscreenTreeWidth).toBeUndefined(); // default is computed (30% vw) in the renderer
    store.set({ artifactFullscreenTreeWidth: 720 });
    expect(createUiSettingsStore(file).get().artifactFullscreenTreeWidth).toBe(720);
    store.set({ artifactFullscreenTreeWidth: 99999 });
    expect(store.get().artifactFullscreenTreeWidth!).toBeLessThanOrEqual(2000);
    store.set({ artifactFullscreenTreeWidth: 10 });
    expect(store.get().artifactFullscreenTreeWidth!).toBeGreaterThanOrEqual(200);
  });

  it('writes atomically — leaves no stray temp file and the result is valid JSON', () => {
    createUiSettingsStore(file).set({ splitRatio: 0.42 });
    const written = readdirSync(join(dir, 'nested'));
    expect(written).toEqual(['ui-settings.json']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ splitRatio: 0.42, lastTab: 'capture', theme: 'light', artifactTreeWidth: 248, keymapProfile: 'auto', showTokenCounts: false });
  });

  it('does not write through a symlinked settings directory (the write cannot escape it) — CWE-59', () => {
    // The settings directory itself is a symlink to an attacker-chosen location; persisting a set
    // must not land ui-settings.json in <target>/ui-settings.json. The in-memory value still updates.
    const outside = mkdtempSync(join(tmpdir(), 'ui-settings-outside-'));
    try {
      symlinkSync(outside, join(dir, 'nested'));
      const store = createUiSettingsStore(file);
      try {
        store.set({ splitRatio: 0.42 });
      } catch {
        /* refusing the symlinked container may throw; the assertions below are the real checks */
      }
      expect(existsSync(join(outside, 'ui-settings.json'))).toBe(false);
      // best-effort persistence: the refused write must not drop the in-memory mutation.
      expect(store.get().splitRatio).toBe(0.42);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
