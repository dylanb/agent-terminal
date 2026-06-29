import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorEventsFile } from '../../src/main/monitorEventsFile';
import type { MonitorEvent } from '../../src/shared/ipc';

// Monitor capture events persist per launch-directory and restore on relaunch regardless of how the
// prior instance terminated (clean quit, window close, crash). The file IS the bucket: a fresh
// backing over the same directory models relaunch. The store NEVER touches the user's .gitignore
// (no-gitignore-writes rule). Real fs, real temp dirs (no mocks).

function evt(over: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    id: 'e1', sessionId: 's1', type: 'capture', source: 'selection',
    text: 'captured', range: null, parentId: null, truncated: false,
    capturedAt: '2026-06-12T10:00:00.000Z', ...over,
  };
}

describe('monitor events file persistence', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'monitor-events-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips events through save/load', () => {
    const backing = createMonitorEventsFile(dir);
    const events = [evt({ id: 'a', text: 'first' }), evt({ id: 'b', text: 'second' })];
    backing.save(events);
    expect(createMonitorEventsFile(dir).load().map((e) => e.id)).toEqual(['a', 'b']);
    expect(createMonitorEventsFile(dir).load().map((e) => e.text)).toEqual(['first', 'second']);
  });

  it('loads an empty list when no file exists yet (never throws)', () => {
    expect(createMonitorEventsFile(dir).load()).toEqual([]);
  });

  it('loads an empty list on a corrupt/unparseable file rather than throwing', () => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    writeFileSync(join(dir, '.agent-terminal', 'monitor-events.json'), '{ not json');
    expect(createMonitorEventsFile(dir).load()).toEqual([]);
  });

  it('never creates a .gitignore on save — the app does not modify the user\'s VCS config', () => {
    createMonitorEventsFile(dir).save([evt()]);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  it('leaves a pre-existing .gitignore byte-for-byte unchanged across saves', () => {
    const before = 'node_modules\n';
    writeFileSync(join(dir, '.gitignore'), before);
    createMonitorEventsFile(dir).save([evt({ id: 'a' })]);
    createMonitorEventsFile(dir).save([evt({ id: 'b' })]);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(before);
  });

  it('drops entries that are not well-formed MonitorEvents (a planted/old-shape file degrades, never replays garbage)', () => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    // One valid event plus one malformed entry per validated field — each must be dropped, so the
    // assertion fails if any field's validation branch is removed (mutation-sensitive).
    // Each entry is malformed in exactly ONE dimension and otherwise well-formed, so the assertion
    // fails (the entry survives and its id appears) if that single validation branch is removed —
    // every FIELD_CHECKS and isRange/isCell branch is independently mutation-sensitive.
    const okRange = { start: { x: 0, y: 0 }, end: { x: 0, y: 0 }, baseY: 0, bufferType: 'normal' };
    const planted: unknown[] = [
      evt({ id: 'good', text: 'real capture', range: { start: { x: 0, y: 1 }, end: { x: 2, y: 3 }, baseY: 0, bufferType: 'normal' } }),
      { ...evt(), id: 123 }, // non-string id (dropped → id never appears)
      { ...evt(), id: 'badsession', sessionId: 123 },
      { ...evt(), id: 'badcaptured', capturedAt: 123 },
      { ...evt(), id: 'badtext', text: 123 },
      { ...evt(), id: 'badtype', type: 'not-a-type' },
      { ...evt(), id: 'badsource', source: 'not-a-source' },
      { ...evt(), id: 'badparent', parentId: 123 },
      { ...evt(), id: 'badtruncated', truncated: 'no' },
      { ...evt(), id: 'rangearray', range: [] }, // typeof [] === 'object' — must still be rejected
      { ...evt(), id: 'rangeempty', range: {} },
      { ...evt(), id: 'rangebadstart', range: { ...okRange, start: { x: 0 } } }, // start missing y
      { ...evt(), id: 'rangebadstartx', range: { ...okRange, start: { y: 0 } } }, // start missing x
      { ...evt(), id: 'rangebadend', range: { ...okRange, end: { x: 0 } } }, // end missing y
      { ...evt(), id: 'rangebadendx', range: { ...okRange, end: { y: 0 } } }, // end missing x
      { ...evt(), id: 'rangecellnotobject', range: { ...okRange, start: 5 } }, // cell not an object
      { ...evt(), id: 'rangebadbasey', range: { ...okRange, baseY: 'x' } }, // non-numeric baseY
      { ...evt(), id: 'rangebadbuffer', range: { ...okRange, bufferType: 'sideways' } },
      { id: 'missing', type: 'capture' }, // missing required fields
      'a bare string',
    ];
    writeFileSync(join(dir, '.agent-terminal', 'monitor-events.json'), JSON.stringify(planted));
    const loaded = createMonitorEventsFile(dir).load();
    expect(loaded.map((e) => e.id)).toEqual(['good']);
  });

  it('round-trips a well-formed non-null range (valid events are not over-rejected)', () => {
    const withRange = evt({ id: 'r', range: { start: { x: 1, y: 2 }, end: { x: 3, y: 4 }, baseY: 5, bufferType: 'alternate' } });
    createMonitorEventsFile(dir).save([withRange]);
    expect(createMonitorEventsFile(dir).load()).toEqual([withRange]);
  });

  it('persists the file with owner-only permissions (captured output may carry secrets)', () => {
    createMonitorEventsFile(dir).save([evt()]);
    const mode = statSync(join(dir, '.agent-terminal', 'monitor-events.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
