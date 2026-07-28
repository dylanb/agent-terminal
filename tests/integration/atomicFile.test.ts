import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, symlinkSync, rmSync, statSync, lstatSync, chmodSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync, isRealContainer, atomicWriteTreeSync, type AtomicWriteTreeMember } from '../../src/main/atomicFile';

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

// AC 5's all-or-nothing migration writer (§B.6/§D.4). A §27 def is a directory tree (<name>.yaml + charter/
// + prompts/), so what must be atomic is the TREE: it stages the whole tree into an unpredictable sibling
// and commits with one renameSync, so no partial <name>/ can exist for the resolver to find. The four
// outcomes are classified by what the DESTINATION is (lstat), never by the commit's errno, so a planted
// symlink (a CWE-59 signal) is never folded into the benign destination-exists case. Real fs, real temp dirs.
describe('atomicWriteTreeSync', () => {
  let root: string;
  let parent: string; // the <userConfigLoopsV2Dir> the write enters
  let dest: string; //   the <name>/ target
  const members: readonly AtomicWriteTreeMember[] = [
    { relPath: 'plan-loop.yaml', data: 'name: plan-loop\n' },
    { relPath: 'charter/principal.md', data: '# principal\n' },
    { relPath: 'prompts/work.md', data: 'do the work\n' },
  ];
  const stageOf = (): string => join(parent, '.plan-loop.stage.tmp');
  const dotSiblings = (): string[] => readdirSync(parent).filter((n) => n.startsWith('.'));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'awt-'));
    parent = join(root, 'loops-v2');
    mkdirSync(parent, { recursive: true });
    dest = join(parent, 'plan-loop');
  });
  afterEach(() => {
    try {
      chmodSync(parent, 0o755);
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the whole tree when the destination is absent, and returns ok', () => {
    const r = atomicWriteTreeSync(dest, members);
    expect(r).toEqual({ ok: true });
    expect(readFileSync(join(dest, 'plan-loop.yaml'), 'utf8')).toBe('name: plan-loop\n');
    expect(readFileSync(join(dest, 'charter/principal.md'), 'utf8')).toBe('# principal\n');
    expect(readFileSync(join(dest, 'prompts/work.md'), 'utf8')).toBe('do the work\n');
    expect(dotSiblings()).toEqual([]); // no staging directory left behind
  });

  // (i)
  it('refuses a pre-existing non-empty destination directory, leaving it byte-for-byte and no staging behind', () => {
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'sentinel.txt'), 'keep-me');
    const r = atomicWriteTreeSync(dest, members, { stageDir: stageOf });
    expect(r).toEqual({ ok: false, cause: 'destination-exists' });
    expect(readFileSync(join(dest, 'sentinel.txt'), 'utf8')).toBe('keep-me');
    expect(existsSync(join(dest, 'plan-loop.yaml'))).toBe(false);
    expect(existsSync(stageOf())).toBe(false);
  });

  // (ii)
  it('throws and does NOT unlink a planted member inside the staging tree, leaving the staging tree in place', () => {
    const stage = stageOf();
    mkdirSync(stage, { recursive: true });
    const planted = join(stage, 'plan-loop.yaml');
    writeFileSync(planted, 'planted');
    expect(() => atomicWriteTreeSync(dest, members, { stageDir: stageOf })).toThrow();
    expect(readFileSync(planted, 'utf8')).toBe('planted'); // never unlinked (CWE-59 signal preserved)
    expect(existsSync(stage)).toBe(true); //             left in place for the operator to inspect
    expect(existsSync(dest)).toBe(false);
  });

  // (iii)
  it('answers container-refused (distinct from destination-exists) for any non-directory at the destination', () => {
    for (const plant of ['symlink-to-dir', 'dangling-symlink', 'plain-file'] as const) {
      rmSync(dest, { recursive: true, force: true });
      if (plant === 'symlink-to-dir') {
        const other = join(root, 'elsewhere');
        mkdirSync(other, { recursive: true });
        symlinkSync(other, dest);
      } else if (plant === 'dangling-symlink') {
        symlinkSync(join(root, 'nowhere'), dest);
      } else {
        writeFileSync(dest, 'i am a file');
      }
      const r = atomicWriteTreeSync(dest, members, { stageDir: stageOf });
      expect(r).toEqual({ ok: false, cause: 'container-refused' });
      expect(r.ok === false && r.cause).not.toBe('destination-exists');
      expect(lstatSync(dest).isDirectory()).toBe(false); // the plant is untouched
      expect(existsSync(stageOf())).toBe(false);
    }
  });

  // (iv)
  it('leaves no <name>/ and no staging directory after a mid-tree failure', () => {
    // A member with an over-long name fails ENAMETOOLONG mid-write — a non-EEXIST throw with no planted
    // entry involved, so cleanup runs and must remove the whole staging tree (the leak clause (ii) exempts).
    const midFail: readonly AtomicWriteTreeMember[] = [
      { relPath: 'ok.txt', data: 'first' },
      { relPath: 'x'.repeat(5000), data: 'name too long → mid-tree write failure' },
    ];
    expect(() => atomicWriteTreeSync(dest, midFail, { stageDir: stageOf })).toThrow();
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(stageOf())).toBe(false);
    expect(dotSiblings()).toEqual([]);
  });

  // (v)
  it.skipIf(process.getuid?.() === 0)(
    'answers container-refused for a non-writable resolved container (0o555), attempting no write',
    () => {
      chmodSync(parent, 0o555);
      const r = atomicWriteTreeSync(dest, members);
      expect(r).toEqual({ ok: false, cause: 'container-refused' });
      chmodSync(parent, 0o755);
      expect(existsSync(dest)).toBe(false); // the step still runs on the app bundle; nothing was written
    },
  );
});
