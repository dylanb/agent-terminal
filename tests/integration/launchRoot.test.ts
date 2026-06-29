import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveLaunchRoot, resolveLaunchSurfaces, APP_LAUNCH_DIR_ENV } from '../../src/main/launchRoot';
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

  it('looks the global flow definition up under $HOME, not the launch target (§18.1)', () => {
    // The user's bug: launched at a repo with no flow, a global flow at ~/.agent-terminal/flow.yaml
    // must still resolve. Binding the flow global dir to L shadowed it; it is now the per-user home.
    const home = join(base, 'home');
    writeGlobalFlow(home, 'home-global-flow');
    const target = join(base, 'launch-elsewhere');
    mkdirSync(target);
    writeGlobalFlow(target, 'launch-target-flow'); // present but must NOT win — proves L is not the global anchor

    const env: NodeJS.ProcessEnv = { HOME: home, [APP_LAUNCH_DIR_ENV]: target };
    const { launchRoot, flowGlobalDir } = resolveLaunchSurfaces(env, '/os-home-unused');
    expect(launchRoot).toBe(realpathSync(target)); // L is still the target, for the cwd surfaces

    const repoNoFlow = join(base, 'repo-without-flow');
    mkdirSync(repoNoFlow);
    const load = loadFlowDefinitionLocalFirst(repoNoFlow, flowGlobalDir);
    expect(load.ok).toBe(true);
    expect(load.ok && load.definition.name).toBe('home-global-flow'); // home wins, not the launch target
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

  it('with no launch target, the env→resolver composition roots every surface at $HOME (§23.4)', () => {
    // Mirror index.ts's no-target wiring: APP_LAUNCH_DIR absent, so L = F = $HOME and the flow global
    // dir is $HOME too — every surface roots there. Falsifies a break in the no-target branch.
    const home = join(base, 'home');
    mkdirSync(home);
    writeGlobalFlow(home, 'home-global-flow');
    const env: NodeJS.ProcessEnv = { HOME: home };
    const repoNoFlow = join(base, 'home-sibling-no-flow');
    mkdirSync(repoNoFlow);

    const { launchRoot, flowGlobalDir } = resolveLaunchSurfaces(env, '/os-home-unused');
    expect(launchRoot).toBe(home);
    expect(flowGlobalDir).toBe(home);

    const shellCwd = buildSpawnConfig({ platform: 'linux', env, cwd: launchRoot }).options.cwd;
    const viewerRoot = discover(launchRoot, 'curated').root;
    const flowLoad = loadFlowDefinitionLocalFirst(repoNoFlow, flowGlobalDir);
    const repoScope = currentRepoInfo(null, null, launchRoot).cwd;

    expect(new Set([shellCwd, viewerRoot, repoScope]).size).toBe(1);
    expect(shellCwd).toBe(home);
    expect(flowLoad.ok && flowLoad.definition.name).toBe('home-global-flow');
  });

  it('the three cwd surfaces root at L while the flow global dir roots at $HOME, before OSC 7', () => {
    // Launch target ≠ $HOME: the shell cwd, viewer root, and repo scope all root at L; the GLOBAL flow
    // (§18.1) resolves under $HOME instead — index.ts's split composition (resolveLaunchSurfaces).
    const home = join(base, 'home');
    const target = join(base, 'work');
    mkdirSync(home);
    mkdirSync(target);
    writeGlobalFlow(home, 'home-global-flow');
    const env: NodeJS.ProcessEnv = { HOME: home, [APP_LAUNCH_DIR_ENV]: target };
    const repoNoFlow = join(base, 'sibling-no-flow');
    mkdirSync(repoNoFlow);

    const { launchRoot, flowGlobalDir } = resolveLaunchSurfaces(env, '/os-home-unused');
    expect(launchRoot).toBe(realpathSync(target));
    expect(flowGlobalDir).toBe(home);

    const shellCwd = buildSpawnConfig({ platform: 'linux', env, cwd: launchRoot }).options.cwd;
    const viewerRoot = discover(launchRoot, 'curated').root;
    const repoScope = currentRepoInfo(null, null, launchRoot).cwd;
    const flowLoad = loadFlowDefinitionLocalFirst(repoNoFlow, flowGlobalDir);

    expect(new Set([shellCwd, viewerRoot, repoScope]).size).toBe(1);
    expect(shellCwd).toBe(realpathSync(target)); // the three cwd surfaces share L
    expect(flowLoad.ok && flowLoad.definition.name).toBe('home-global-flow'); // flow split off to home
  });
});
