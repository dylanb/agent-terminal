import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveRepoKey } from '../../src/main/repoKey';

// Real temp dirs — repoKey walks the real filesystem for `.git` (§16.3). No mocks.
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

  it('returns an absolute path even for a relative cwd', () => {
    const dir = tmp();
    const rel = path.relative(process.cwd(), dir);
    expect(path.isAbsolute(resolveRepoKey(rel))).toBe(true);
  });
});
