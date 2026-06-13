import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(createUiSettingsStore(file).get()).toEqual({ splitRatio: 0.4, lastTab: 'todo' });
  });

  it('merges a partial set, leaving untouched fields intact', () => {
    const store = createUiSettingsStore(file);
    store.set({ splitRatio: 0.5 });
    store.set({ lastTab: 'todo' });
    expect(store.get()).toEqual({ splitRatio: 0.5, lastTab: 'todo' });
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

  it('writes atomically — leaves no stray temp file and the result is valid JSON', () => {
    createUiSettingsStore(file).set({ splitRatio: 0.42 });
    const written = readdirSync(join(dir, 'nested'));
    expect(written).toEqual(['ui-settings.json']);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ splitRatio: 0.42, lastTab: 'capture' });
  });
});
