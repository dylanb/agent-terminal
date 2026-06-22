import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CHROME_MARKERS } from '../../src/main/chrome';
import { createChromeProfileStore } from '../../src/main/chromeProfile';

describe('chrome profile store (§15.x — learned, persisted chrome markers)', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chrome-profile-'));
    file = join(dir, 'nested', 'chrome-profile.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts with the seeded default markers', () => {
    const store = createChromeProfileStore(file);
    expect([...store.markers()].sort()).toEqual([...DEFAULT_CHROME_MARKERS].sort());
  });

  it('learn() adds new markers on top of the defaults and dedupes', () => {
    const store = createChromeProfileStore(file);
    const after = store.learn(['◆', '◆', '✻']);
    expect(after).toContain('◆');
    expect(after.filter((m) => m === '◆')).toHaveLength(1);
    expect(after.filter((m) => m === '✻')).toHaveLength(1);
    for (const d of DEFAULT_CHROME_MARKERS) expect(after).toContain(d);
  });

  it('persists learned markers across a restart (fresh store, same path)', () => {
    createChromeProfileStore(file).learn(['◆']);
    expect(createChromeProfileStore(file).markers()).toContain('◆');
  });

  it('ignores empty/whitespace markers', () => {
    const store = createChromeProfileStore(file);
    const after = store.learn(['', '   ']);
    expect([...after].sort()).toEqual([...DEFAULT_CHROME_MARKERS].sort());
  });

  it('degrades a corrupt file to the defaults without throwing', () => {
    const corrupt = join(dir, 'chrome-profile.json');
    writeFileSync(corrupt, 'not json {{{');
    expect(() => createChromeProfileStore(corrupt).markers()).not.toThrow();
    expect([...createChromeProfileStore(corrupt).markers()].sort()).toEqual([...DEFAULT_CHROME_MARKERS].sort());
  });
});
