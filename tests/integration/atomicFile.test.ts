import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync, isRealContainer } from '../../src/main/atomicFile';

// The shared hardened atomic-write primitive (§19.1/§25): app-owned state is written through an
// unpredictable temp + exclusive create + rename, refusing a symlinked container directory so a
// cloned repo cannot redirect the write out of the launch dir (CWE-59). Real fs, real temp dirs.

describe('atomicWriteFileSync', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atomic-file-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the data and returns true on success', () => {
    const file = join(dir, 'sub', 'state.json');
    expect(atomicWriteFileSync(file, 'hello')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('hello');
  });

  it('creates the container directory when it does not exist yet', () => {
    const file = join(dir, 'nested', 'deeper', 'state.json');
    atomicWriteFileSync(file, '{}');
    expect(existsSync(join(dir, 'nested', 'deeper'))).toBe(true);
  });

  it('writes owner-only (0o600) by default, and honors an explicit mode', () => {
    // writeFileSync's mode is masked by the process umask; pin it so the explicit-0o644 assertion is
    // not cleared to 0o600 under a restrictive runner umask (e.g. 0o077).
    const prevMask = process.umask(0o022);
    try {
      const a = join(dir, 'a.json');
      atomicWriteFileSync(a, '1');
      expect(statSync(a).mode & 0o777).toBe(0o600);
      const b = join(dir, 'b.json');
      atomicWriteFileSync(b, '1', { mode: 0o644 });
      expect(statSync(b).mode & 0o777).toBe(0o644);
    } finally {
      process.umask(prevMask);
    }
  });

  it('refuses to write through a symlinked container directory (returns false, writes nothing) — CWE-59', () => {
    // A cloned repo ships the container as a symlink to an attacker-chosen directory; the write must
    // not escape into <target>/state.json. lstat (not stat) rejects the directory symlink.
    const outside = mkdtempSync(join(tmpdir(), 'atomic-file-outside-'));
    try {
      symlinkSync(outside, join(dir, '.agent-terminal'));
      const file = join(dir, '.agent-terminal', 'state.json');
      expect(atomicWriteFileSync(file, 'secret')).toBe(false);
      expect(existsSync(join(outside, 'state.json'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses through a symlink pre-planted at the exact temp path (exclusive create, not the random name)', () => {
    // The tmpPath seam forces the otherwise-unpredictable temp onto a planted symlink pointing at a
    // victim file; the exclusive-create `wx` must refuse to open it so the victim is never clobbered.
    const target = join(dir, 'victim.txt');
    const original = 'do-not-overwrite\n';
    writeFileSync(target, original);
    const tmp = join(dir, 'state.json.planted.tmp');
    symlinkSync(target, tmp);
    expect(() => atomicWriteFileSync(join(dir, 'state.json'), 'real', { tmpPath: () => tmp })).toThrow();
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  it('removes its own temp file when the rename fails, so a persistent failure cannot orphan temps (CWE-459)', () => {
    // The unpredictable per-write temp name means a leak accumulates one stale file per failed write
    // (unlike the old fixed `.tmp` name). Force renameSync to fail by making the destination a
    // directory; the exclusive-created temp is ours, so it must be unlinked rather than left behind.
    const destDir = join(dir, 'state.json');
    mkdirSync(destDir);
    const tmp = join(dir, 'state.json.leaky.tmp');
    expect(() => atomicWriteFileSync(destDir, 'data', { tmpPath: () => tmp })).toThrow();
    expect(existsSync(tmp)).toBe(false);
  });

  it('leaves a pre-existing regular file at the temp path untouched (only a temp it created is cleaned up — EEXIST)', () => {
    // The exclusive create fails EEXIST on any pre-existing temp path; that file is not one this write
    // created, so the failure cleanup must not unlink it (collapsing the guard to an unconditional
    // unlink would delete it). A symlink at the temp path cannot prove this — unlinking a symlink
    // spares its target — so the planted file here is a regular file.
    const planted = join(dir, 'state.json.preexisting.tmp');
    const original = 'not-ours\n';
    writeFileSync(planted, original);
    expect(() => atomicWriteFileSync(join(dir, 'state.json'), 'real', { tmpPath: () => planted })).toThrow();
    expect(readFileSync(planted, 'utf8')).toBe(original);
  });

  it('never creates a .gitignore and leaves a pre-existing one byte-for-byte unchanged', () => {
    const before = 'node_modules\n';
    writeFileSync(join(dir, '.gitignore'), before);
    atomicWriteFileSync(join(dir, '.agent-terminal', 'state.json'), '{}');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(before);
    expect(existsSync(join(dir, '.agent-terminal', '.gitignore'))).toBe(false);
  });
});

describe('isRealContainer', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atomic-file-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is true for a real directory and for one that does not exist yet (mkdir will make a real one)', () => {
    expect(isRealContainer(dir)).toBe(true);
    expect(isRealContainer(join(dir, 'not-yet'))).toBe(true);
  });

  it('is false for a directory symlink (lstat does not follow it)', () => {
    const outside = mkdtempSync(join(tmpdir(), 'atomic-file-outside-'));
    try {
      symlinkSync(outside, join(dir, 'link'));
      expect(isRealContainer(join(dir, 'link'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // A lstat that THROWS is never a symlink — a symlink always lstats successfully. So a throw must NOT be
  // reported as "reject: symlink"; the only job here is symlink rejection, and returning false on a throw
  // masks a real error (EACCES/ENOTDIR) as a link that isn't there and silently drops the write. `false`
  // means exactly one thing: a confirmed non-directory in place. Everything else proceeds so the write's own
  // error surfaces (regression: round 8 narrowed this to ENOENT-only and turned EACCES into a silent skip).
  it('is true when lstat throws for a reason that is not a symlink (a non-directory on the path)', () => {
    const file = join(dir, 'afile');
    writeFileSync(file, 'x');
    expect(isRealContainer(join(file, 'child'))).toBe(true); // ENOTDIR — not a symlink, so not refused
  });
});
