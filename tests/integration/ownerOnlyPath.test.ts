import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isPrivateDirectory, ownerOnlyChain, ownerOnlyPath } from '../../src/main/ownerOnlyPath';

const me = process.getuid?.() ?? -1;
const isRoot = me === 0;
const someoneElse = me + 1;

let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(homedir(), '.agent-terminal-test-')));
  chmodSync(base, 0o700);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const folder = (rel: string, mode: number): string => {
  const dir = join(base, rel);
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, mode);
  return dir;
};

const file = (rel: string, mode: number): string => {
  const p = join(base, rel);
  writeFileSync(p, 'x');
  chmodSync(p, mode);
  return p;
};

describe('ownerOnlyChain', () => {
  it('accepts a folder chain that only the user (or root) can write', () => {
    expect(ownerOnlyChain(folder('a/b', 0o755), me)).toEqual({ kind: 'ownerOnly' });
  });

  it.each([0o775, 0o757])('reports a folder with mode %o as writable by others', (mode) => {
    expect(ownerOnlyChain(folder('a', mode), me)).toEqual({ kind: 'othersCanWrite' });
  });

  it('reports an other-writable ancestor', () => {
    folder('outer', 0o777);
    expect(ownerOnlyChain(folder('outer/inner', 0o755), me)).toEqual({ kind: 'othersCanWrite' });
  });

  it('checks the real folders behind a symlink, not the link', () => {
    const real = folder('shared/real', 0o755);
    chmodSync(join(base, 'shared'), 0o777);
    const owned = folder('owned', 0o755);
    symlinkSync(real, join(owned, 'link'));
    expect(ownerOnlyChain(join(owned, 'link'), me)).toEqual({ kind: 'othersCanWrite' });
  });

  it('stops before the folder it is told to stop at', () => {
    const top = folder('top', 0o777);
    expect(ownerOnlyChain(folder('top/below', 0o755), me, top)).toEqual({ kind: 'ownerOnly' });
  });

  it.skipIf(isRoot)('reports a folder owned by another user, although no one else can write it by mode', () => {
    expect(ownerOnlyChain(folder('a', 0o755), someoneElse)).toEqual({ kind: 'ownedByAnother' });
  });

  it.skipIf(isRoot)('accepts folders owned by root for any user', () => {
    expect(ownerOnlyChain('/usr', someoneElse)).toEqual({ kind: 'ownerOnly' });
  });

  it('reports a path it cannot examine, with the operating system reason', () => {
    const result = ownerOnlyChain(join(base, 'missing'), me);
    expect(result.kind).toBe('unreadable');
    expect(result.kind === 'unreadable' ? String(result.error) : '').toMatch(/ENOENT/);
  });
});

describe('ownerOnlyPath', () => {
  it('accepts a file only its owner can write', () => {
    expect(ownerOnlyPath(file('f', 0o755), me)).toEqual({ kind: 'ownerOnly' });
  });

  it.each([0o775, 0o757])('reports a file with mode %o as writable by others', (mode) => {
    expect(ownerOnlyPath(file('f', mode), me)).toEqual({ kind: 'othersCanWrite' });
  });

  it('does not judge the folders above the file', () => {
    folder('open', 0o777);
    expect(ownerOnlyPath(file('open/f', 0o755), me)).toEqual({ kind: 'ownerOnly' });
  });

  it.skipIf(isRoot)('reports a file owned by another user', () => {
    expect(ownerOnlyPath(file('f', 0o755), someoneElse)).toEqual({ kind: 'ownedByAnother' });
  });

  it('reports a file it cannot examine', () => {
    expect(ownerOnlyPath(join(base, 'missing'), me).kind).toBe('unreadable');
  });
});

describe('isPrivateDirectory', () => {
  it('accepts a directory the user owns with mode 0700', () => {
    expect(isPrivateDirectory(lstatSync(folder('p', 0o700)), me)).toBe(true);
  });

  it.each([0o750, 0o705, 0o770])('rejects mode %o', (mode) => {
    expect(isPrivateDirectory(lstatSync(folder('p', mode)), me)).toBe(false);
  });

  it('rejects a directory the user does not own', () => {
    expect(isPrivateDirectory(lstatSync(folder('p', 0o700)), someoneElse)).toBe(false);
  });

  it('rejects a file and a symlink', () => {
    const dir = folder('p', 0o700);
    symlinkSync(dir, join(base, 'link'));
    expect(isPrivateDirectory(lstatSync(file('f', 0o700)), me)).toBe(false);
    expect(isPrivateDirectory(lstatSync(join(base, 'link')), me)).toBe(false);
  });
});
