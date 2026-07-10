import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { resolveJail, confinedRealPath, realpathBounded } from '../../src/main/confinedPath';

let root: string;
let repo: string;
let outside: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'confined-')));
  repo = join(root, 'repo');
  outside = join(root, 'outside');
  mkdirSync(join(repo, '.agent-loop'), { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('resolveJail', () => {
  it('resolves the anchor through symlinks but joins the named segments literally', () => {
    const linkedRepo = join(root, 'linked-repo');
    symlinkSync(repo, linkedRepo);

    expect(resolveJail(linkedRepo, '.agent-loop')).toBe(join(repo, '.agent-loop'));
  });

  it('does NOT follow a symlink at a named segment, so a planted jail link cannot widen the jail', () => {
    const linkedJail = join(repo, 'linked-jail');
    symlinkSync(outside, linkedJail);

    expect(resolveJail(repo, 'linked-jail')).toBe(join(repo, 'linked-jail'));
  });

  it('is null when the anchor does not exist', () => {
    expect(resolveJail(join(root, 'absent'), '.agent-loop')).toBeNull();
  });

  it('resolves the anchor itself when no segments are named', () => {
    expect(resolveJail(repo)).toBe(repo);
  });
});

describe('realpathBounded', () => {
  it('resolves a symlinked ancestor and appends the not-yet-created tail', () => {
    const link = join(root, 'link');
    symlinkSync(repo, link);

    expect(realpathBounded(join(link, 'nope', 'deep.md'))).toBe(join(repo, 'nope', 'deep.md'));
  });

  it('returns the input when nothing in the path exists', () => {
    const absent = join(root, 'a', 'b', 'c');
    expect(realpathBounded(absent)).toBe(join(root, 'a', 'b', 'c'));
  });
});

describe('confinedRealPath', () => {
  const jail = () => join(repo, '.agent-loop');

  it('accepts a plain path inside the jail', () => {
    const target = join(jail(), 'plan.md');
    writeFileSync(target, 'x');

    expect(confinedRealPath(jail(), target)).toBe(target);
  });

  it('accepts the jail directory itself', () => {
    expect(confinedRealPath(jail(), jail())).toBe(jail());
  });

  it('accepts a path whose final segments do not exist yet', () => {
    expect(confinedRealPath(jail(), join(jail(), 'reviews', '1.json'))).toBe(
      join(jail(), 'reviews', '1.json'),
    );
  });

  it('returns the SYMLINK-FREE path so a later swap cannot redirect the read (CWE-367)', () => {
    const real = join(jail(), 'real.md');
    writeFileSync(real, 'x');
    symlinkSync(real, join(jail(), 'alias.md'));

    expect(confinedRealPath(jail(), join(jail(), 'alias.md'))).toBe(real);
  });

  it('rejects a symlink inside the jail that resolves outside it (CWE-59)', () => {
    const evil = join(outside, 'evil.md');
    writeFileSync(evil, 'x');
    symlinkSync(evil, join(jail(), 'escape.md'));

    expect(confinedRealPath(jail(), join(jail(), 'escape.md'))).toBeNull();
  });

  it('rejects a path that escapes the jail lexically (CWE-22)', () => {
    expect(confinedRealPath(jail(), join(jail(), '..', '..', 'outside', 'evil.md'))).toBeNull();
  });

  it('rejects a sibling directory that merely shares the jail name as a prefix', () => {
    const sibling = `${jail()}-evil`;
    mkdirSync(sibling);

    expect(confinedRealPath(jail(), join(sibling, 'x.md'))).toBeNull();
  });

  it('rejects when a not-yet-created tail hangs off a symlinked ancestor pointing out of the jail', () => {
    symlinkSync(outside, join(jail(), 'linkdir'));

    expect(confinedRealPath(jail(), join(jail(), 'linkdir', 'absent.md'))).toBeNull();
  });

  it('accepts a path inside a jail that is the filesystem root', () => {
    expect(confinedRealPath(sep, root)).toBe(root);
  });

  it('confines to the jail it is given, not to any hardcoded directory name', () => {
    const other = join(repo, 'other');
    mkdirSync(other);
    const target = join(other, 'file.md');
    writeFileSync(target, 'x');

    expect(confinedRealPath(other, target)).toBe(target);
    expect(confinedRealPath(jail(), target)).toBeNull();
    expect(jail().startsWith(repo + sep)).toBe(true);
  });
});
