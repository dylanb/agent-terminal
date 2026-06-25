import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLaunchRoot } from '../../src/main/launchRoot';
import { buildSpawnConfig } from '../../src/main/pty';
import { currentRepoInfo } from '../../src/main/repoKey';
import { discover } from '../../src/main/artifactTree';
import { loadFlowDefinitionLocalFirst } from '../../src/main/flow';

const FALLBACK = '/home/fallback-marker';
const FLOW_REL = join('.agent-terminal', 'flow.yaml');

function writeGlobalFlow(dir: string, name: string): void {
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(join(dir, FLOW_REL), `name: ${name}\nsteps:\n  - id: only\n    kind: manual\n`);
}

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

  it('the spawn-config builder roots the PTY cwd at the resolved launch root (§5)', () => {
    const dir = join(base, 'work');
    mkdirSync(dir);
    const root = resolveLaunchRoot(dir, FALLBACK);
    const cfg = buildSpawnConfig({ platform: 'linux', env: { HOME: FALLBACK }, cwd: root });
    expect(cfg.options.cwd).toBe(root);
  });

  it('the artifact viewer roots its tree at the launch root before OSC 7 (§20.1)', () => {
    const dir = join(base, 'work');
    mkdirSync(dir);
    writeFileSync(join(dir, 'note.md'), '# n\n');
    const root = resolveLaunchRoot(dir, FALLBACK);
    expect(discover(root, 'curated').root).toBe(root);
  });

  it('the flow global directory looks the global flow definition up under the launch root (§18.1)', () => {
    const launch = join(base, 'launch');
    writeGlobalFlow(launch, 'global-flow');
    const root = resolveLaunchRoot(launch, FALLBACK);

    const repoNoFlow = join(base, 'repo-without-flow');
    mkdirSync(repoNoFlow);
    const load = loadFlowDefinitionLocalFirst(repoNoFlow, root);
    expect(load.ok).toBe(true);
    expect(load.ok && load.definition.name).toBe('global-flow');
  });

  it('the repo-scope fallback scopes to the launch root itself when it is not a repo (§16.3)', () => {
    const dir = join(base, 'no-repo');
    mkdirSync(dir);
    const root = resolveLaunchRoot(dir, FALLBACK);
    const info = currentRepoInfo(null, null, root);
    expect(info.cwd).toBe(root);
    expect(info.repoKey).toBe(root);
  });

  it('the repo-scope fallback scopes to the containing repo when the launch root is inside one (§16.3)', () => {
    const repo = join(base, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const sub = join(repo, 'src');
    mkdirSync(sub);
    const root = resolveLaunchRoot(sub, FALLBACK);
    const info = currentRepoInfo(null, null, root);
    expect(info.repoKey).toBe(realpathSync(repo));
  });

  it('all four surfaces resolve to the same launch root before OSC 7, exercising each real path', () => {
    const dir = join(base, 'work');
    mkdirSync(dir);
    writeGlobalFlow(dir, 'one-root-flow');
    const root = resolveLaunchRoot(dir, FALLBACK);
    const repoNoFlow = join(base, 'sibling-no-flow');
    mkdirSync(repoNoFlow);

    const shellCwd = buildSpawnConfig({ platform: 'linux', env: { HOME: FALLBACK }, cwd: root })
      .options.cwd;
    const viewerRoot = discover(root, 'curated').root;
    const flowLoad = loadFlowDefinitionLocalFirst(repoNoFlow, root);
    const repoScope = currentRepoInfo(null, null, root).cwd;

    expect(new Set([shellCwd, viewerRoot, repoScope]).size).toBe(1);
    expect(shellCwd).toBe(root);
    expect(flowLoad.ok && flowLoad.definition.name).toBe('one-root-flow');
  });
});
