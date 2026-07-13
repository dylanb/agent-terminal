import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readDirEntries } from '../../src/main/dirEntries';

// The one enumeration policy both tree readers share (§18.1). Its whole point is that an ABSENT tree and
// an UNREADABLE one are not the same thing: a reader that returns [] for both installs nothing and reports
// success. So the rethrow is the behaviour under test, not an implementation detail.

const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dir-entries-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readDirEntries', () => {
  it('lists files and directories, name-sorted', () => {
    writeFileSync(path.join(dir, 'b.md'), 'b');
    writeFileSync(path.join(dir, 'a.md'), 'a');
    mkdirSync(path.join(dir, 'sub'));
    expect(readDirEntries(dir)).toEqual([
      { name: 'a.md', isDirectory: false, isFile: true },
      { name: 'b.md', isDirectory: false, isFile: true },
      { name: 'sub', isDirectory: true, isFile: false },
    ]);
  });

  it('yields nothing for an ABSENT directory — an optional subtree is legitimately empty', () => {
    expect(readDirEntries(path.join(dir, 'no-such-dir'))).toEqual([]);
  });

  it.skipIf(asRoot)('THROWS for an unreadable directory rather than reporting it empty', () => {
    // The distinction this module exists for: enumerating an unreadable tree to [] is indistinguishable
    // from an empty one, and the installer above it then seeds nothing while telling the user it worked.
    const locked = path.join(dir, 'locked');
    mkdirSync(locked);
    writeFileSync(path.join(locked, 'a.md'), 'a');
    chmodSync(locked, 0o000);
    try {
      expect(() => readDirEntries(locked)).toThrow();
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('THROWS when the path is a file, not a directory', () => {
    const file = path.join(dir, 'a.md');
    writeFileSync(file, 'a');
    expect(() => readDirEntries(file)).toThrow();
  });
});
