import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findRepoRoot, resolveRepoKey, currentRepoInfo } from '../../src/main/repoKey';

// §16.3: repoKey walks the real filesystem for `.git`. Real temp dirs, no mocks.
describe('resolveRepoKey (§16.3 — git repo root / non-repo dir key)', () => {
  const made: string[] = [];
  function tmp(): string {
    const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'repokey-')));
    made.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('returns the repo root when cwd is the root of a git repo', () => {
    const root = tmp();
    mkdirSync(path.join(root, '.git'));
    expect(resolveRepoKey(root)).toBe(root);
  });

  it('returns the repo root for a nested subdirectory of the repo', () => {
    const root = tmp();
    mkdirSync(path.join(root, '.git'));
    const nested = path.join(root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(resolveRepoKey(nested)).toBe(root);
  });

  it('keys a non-repo directory on the directory itself', () => {
    const dir = tmp();
    expect(resolveRepoKey(dir)).toBe(dir);
  });

  it('treats a `.git` file (worktree/submodule) as a repo root', () => {
    const root = tmp();
    writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere\n');
    expect(resolveRepoKey(path.join(root))).toBe(root);
  });

  it('finds the same root resolveRepoKey keys on, and null outside any repository', () => {
    const root = tmp();
    mkdirSync(path.join(root, '.git'));
    const nested = path.join(root, 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    const worktree = tmp();
    writeFileSync(path.join(worktree, '.git'), 'gitdir: /elsewhere\n');
    const plain = tmp();
    expect({
      root: findRepoRoot(root),
      nested: findRepoRoot(nested),
      worktree: findRepoRoot(worktree),
      plain: findRepoRoot(plain),
    }).toEqual({ root, nested: root, worktree, plain: null });
  });

  it('returns an absolute path even for a relative cwd', () => {
    const dir = tmp();
    const rel = path.relative(process.cwd(), dir);
    expect(path.isAbsolute(resolveRepoKey(rel))).toBe(true);
  });

  // §16.3/§20.1: before any OSC 7 reports a cwd, the repo key falls back to the spawn cwd (home) so
  // the todo path is never keyless, matching the artifact viewer.
  describe('currentRepoInfo — fallback to the spawn cwd when untracked', () => {
    it('uses the tracked cwd/key when OSC 7 has reported one', () => {
      const root = tmp();
      mkdirSync(path.join(root, '.git'));
      expect(currentRepoInfo(root, root, '/some/home')).toEqual({ cwd: root, repoKey: root });
    });

    it('falls back to the spawn cwd (and resolves its key) when nothing is tracked yet', () => {
      const home = tmp(); // a non-repo dir standing in for $HOME
      expect(currentRepoInfo(null, null, home)).toEqual({ cwd: home, repoKey: home });
    });
  });
});
