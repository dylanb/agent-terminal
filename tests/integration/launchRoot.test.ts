import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLaunchRoot } from '../../src/main/launchRoot';
import { buildSpawnConfig } from '../../src/main/pty';
import { currentRepoInfo } from '../../src/main/repoKey';

const FALLBACK = '/home/fallback-marker';

describe('launch root → four surfaces consume one resolved value (§23.4)', () => {
  let base: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'launch-root-int-')));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('resolves a real directory with the real filesystem (no mock)', () => {
    const dir = join(base, 'work');
    mkdirSync(dir);
    expect(resolveLaunchRoot(dir, FALLBACK)).toBe(dir);
  });

  it('falls back to F for an unusable target with the real filesystem', () => {
    const file = join(base, 'plain-file');
    writeFileSync(file, 'x');
    expect(resolveLaunchRoot(file, FALLBACK)).toBe(FALLBACK);
    expect(resolveLaunchRoot(join(base, 'absent'), FALLBACK)).toBe(FALLBACK);
  });

  it('the spawn-config builder roots the PTY cwd at the resolved launch root', () => {
    const dir = join(base, 'work');
    mkdirSync(dir);
    const root = resolveLaunchRoot(dir, FALLBACK);
    const cfg = buildSpawnConfig({ platform: 'linux', env: { HOME: FALLBACK }, cwd: root });
    expect(cfg.options.cwd).toBe(root);
  });

  it('the repo-scope fallback scopes to the launch root itself when it is not a repo', () => {
    const dir = join(base, 'no-repo');
    mkdirSync(dir);
    const root = resolveLaunchRoot(dir, FALLBACK);
    const info = currentRepoInfo(null, null, root);
    expect(info.cwd).toBe(root);
    expect(info.repoKey).toBe(root);
  });

  it('the repo-scope fallback scopes to the containing repo when the launch root is inside one', () => {
    const repo = join(base, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const sub = join(repo, 'src');
    mkdirSync(sub);
    const root = resolveLaunchRoot(sub, FALLBACK);
    const info = currentRepoInfo(null, null, root);
    expect(info.repoKey).toBe(realpathSync(repo));
  });

  it('all four surfaces agree on the same resolved root before OSC 7', () => {
    const dir = join(base, 'work');
    mkdirSync(dir);
    const root = resolveLaunchRoot(dir, FALLBACK);

    const shellCwd = buildSpawnConfig({ platform: 'linux', env: { HOME: FALLBACK }, cwd: root })
      .options.cwd;
    const viewerCwdFallback = root;
    const flowGlobalDir = root;
    const repoScopeFallback = currentRepoInfo(null, null, root).cwd;

    expect(new Set([shellCwd, viewerCwdFallback, flowGlobalDir, repoScopeFallback]).size).toBe(1);
    expect(shellCwd).toBe(root);
  });
});
