import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitorEventsFile, MAX_EVENTS_FILE_BYTES } from '../../src/main/monitorEventsFile';
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

  it('refuses to write through a symlink pre-planted at the exact temp path (exclusive create, not the random name)', () => {
    // A cloned repo pre-plants a symlink at the precise temp path save() will use, pointing at one of
    // the user's files; the exclusive-create `wx` flag must refuse to open it so the target is never
    // clobbered (CWE-59 link following). The tmpPath seam forces the otherwise-unpredictable temp path
    // onto the planted location, so this exercises the `wx` refusal itself — removing `flag:'wx'` from
    // save() turns this red (the write would follow the symlink and overwrite the victim).
    const target = join(dir, 'victim.txt');
    const original = 'do-not-overwrite\n';
    writeFileSync(target, original);
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    const tmp = join(dir, '.agent-terminal', 'monitor-events.json.planted.tmp');
    symlinkSync(target, tmp);
    expect(() => createMonitorEventsFile(dir, { tmpPath: () => tmp }).save([evt({ id: 'a', text: 'real' })])).toThrow();
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  it('does not read through a symlinked .agent-terminal directory (a cloned repo cannot redirect the read)', () => {
    // A cloned repo ships `.agent-terminal` itself as a symlink to an attacker-chosen directory; the
    // loader must not traverse the directory symlink to read <target>/monitor-events.json (CWE-59).
    const outside = mkdtempSync(join(tmpdir(), 'monitor-events-outside-'));
    try {
      writeFileSync(join(outside, 'monitor-events.json'), JSON.stringify([evt({ id: 'leaked' })]));
      symlinkSync(outside, join(dir, '.agent-terminal'));
      expect(createMonitorEventsFile(dir).load()).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not write through a symlinked .agent-terminal directory (the write cannot escape the launch dir)', () => {
    // The save-path twin of the read guard: a `.agent-terminal` directory symlink must not let the
    // captured output (which may carry secrets) land in the attacker-chosen target directory (CWE-59).
    const outside = mkdtempSync(join(tmpdir(), 'monitor-events-outside-'));
    try {
      symlinkSync(outside, join(dir, '.agent-terminal'));
      try {
        createMonitorEventsFile(dir).save([evt({ id: 'a' })]);
      } catch {
        /* refusing the symlinked container may throw; the assertion below is the real check */
      }
      expect(existsSync(join(outside, 'monitor-events.json'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('degrades to an empty list when the file exceeds the size cap (an oversized planted file cannot stall startup)', () => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    // Valid JSON that would otherwise load one event, but larger than the cap → refused (CWE-400).
    const huge = JSON.stringify([evt({ id: 'big', text: 'a'.repeat(MAX_EVENTS_FILE_BYTES) })]);
    writeFileSync(join(dir, '.agent-terminal', 'monitor-events.json'), huge);
    expect(createMonitorEventsFile(dir).load()).toEqual([]);
  });

  it('loads the same-shaped payload when it is under the cap (the cap refuses size, not shape — positive control)', () => {
    createMonitorEventsFile(dir).save([evt({ id: 'small', text: 'a'.repeat(1024) })]);
    expect(createMonitorEventsFile(dir).load().map((e) => e.id)).toEqual(['small']);
  });

  it('refuses a symlinked events file (a planted symlink cannot bypass the size guard or read the target)', () => {
    // statSync follows symlinks and reports the target's size; a repo could symlink the events file
    // to a special file (e.g. /dev/zero) to slip past the cap and then hang the synchronous read.
    // The loader must refuse a non-regular file outright (CWE-59/CWE-400).
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    const realTarget = join(dir, 'real-events.json');
    writeFileSync(realTarget, JSON.stringify([evt({ id: 'x' })]));
    symlinkSync(realTarget, join(dir, '.agent-terminal', 'monitor-events.json'));
    expect(createMonitorEventsFile(dir).load()).toEqual([]);
  });

  it('drops inject-able command-output events on load (an untrusted file cannot seed an Insert-at-cursor card)', () => {
    // command-output is the one type whose monitor card injects into the live PTY (§16.2); a
    // repo-shipped file must not be able to restore one (CWE-78 untrusted-data-as-syntax).
    createMonitorEventsFile(dir).save([
      evt({ id: 'keep', type: 'capture', text: 'safe' }),
      evt({ id: 'evil', type: 'command-output', text: 'rm -rf ~' }),
    ]);
    expect(createMonitorEventsFile(dir).load().map((e) => e.id)).toEqual(['keep']);
  });

  it('restores only in the same launch directory (events saved under A do not leak into B)', () => {
    const dirB = mkdtempSync(join(tmpdir(), 'monitor-events-b-'));
    try {
      createMonitorEventsFile(dir).save([evt({ id: 'a' })]);
      expect(createMonitorEventsFile(dirB).load()).toEqual([]);
    } finally {
      rmSync(dirB, { recursive: true, force: true });
    }
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
