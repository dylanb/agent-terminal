import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createBenchFixtureBuilder, FAKE_ORIGIN_URL, type BenchFixtureBuilder } from '../helpers/benchFixtureBuilder';
import { createBenchRoots, type BenchRoots } from '../helpers/benchRoots';
import { seedFakeGhGit } from '../e2e/fakeTools';
import { resolveGitHubRepository } from '../../src/main/githubRepository';
import { readActiveFlow } from '../../src/main/activeFlowPointer';
import { catalogEntryDefFile, loadUntrustedFlowDefinition } from '../../src/main/flow';
import { resolveJail } from '../../src/main/confinedPath';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from '../../src/main/appLoopPaths';
import { resolveAppHome } from '../../src/main/launchRoot';
import { userConfigRoot, userConfigRootFrom } from '../../src/main/userConfig';
import { homedir } from 'node:os';
import { resolveExampleLoopsV2Dir } from '../../src/main/exampleAssets';

const V3_FLOW = readFileSync(join(process.cwd(), 'example', 'flows', 'feature-dev-v3', 'flow.yaml'), 'utf8');

let b: BenchFixtureBuilder;
let roots: BenchRoots | undefined;
const extraDirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  b?.cleanup();
  roots?.cleanup();
  roots = undefined;
  for (const d of extraDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the bench fixture builder', () => {
  it('makes a committed repository whose origin the fake gh resolves, and which ignores .agent-terminal/', async () => {
    b = createBenchFixtureBuilder();
    const { dir, commit } = b.makeRepository('bench-repo');
    expect(b.git(dir, ['rev-parse', 'HEAD'])).toBe(commit);
    expect(b.git(dir, ['config', '--get', 'remote.origin.url'])).toBe(FAKE_ORIGIN_URL);
    b.writeArtifacts(dir, { 'plan.md': '# plan\n' });
    expect(b.git(dir, ['status', '--porcelain'])).toBe('');

    const { ghOnlyBinDir, binDir, logFile } = seedFakeGhGit('bench-builder-gh-');
    extraDirs.push(ghOnlyBinDir, binDir);
    vi.stubEnv('PATH', `${ghOnlyBinDir}:${process.env.PATH}`);
    vi.stubEnv('FAKE_GHGIT_LOG', logFile);
    const repo = await resolveGitHubRepository(dir);
    expect(repo.selector).toBe('github.com/fake/repo');
  });

  it('installs a flow the app reads back as the active catalog entry', () => {
    b = createBenchFixtureBuilder();
    const { dir } = b.makeRepository('bench-flow');
    b.seedFlow(dir, 'feature-dev-v3', V3_FLOW);
    expect(readActiveFlow(dir)).toEqual({ kind: 'value', id: 'feature-dev-v3' });
    const load = loadUntrustedFlowDefinition(catalogEntryDefFile(dir, 'feature-dev-v3'));
    expect(load.ok && load.definition.name).toBe('feature-dev-v3');
  });

  it('writes artifacts, a subfolder included, where the app\'s artifacts jail reads them', () => {
    b = createBenchFixtureBuilder();
    const { dir } = b.makeRepository('bench-art');
    b.writeArtifacts(dir, { 'plan.md': '# plan\n', 'impl-report/infra.md': '## infra\n' });
    const jail = resolveJail(dir, ...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR);
    expect(jail).not.toBeNull();
    expect(readFileSync(join(jail!, 'plan.md'), 'utf8')).toBe('# plan\n');
    expect(readFileSync(join(jail!, 'impl-report', 'infra.md'), 'utf8')).toBe('## infra\n');
  });

  it('commits a tracked path as a symlink out of the tree, and leaves the tree clean', () => {
    b = createBenchFixtureBuilder();
    const outside = b.outsideDir('bench-link-outside');
    for (const rel of ['.agent-terminal/loop/artifacts', '.agent-terminal']) {
      const { dir: repo, commit } = b.makeRepository(`bench-link-${rel.length}`);
      const linked = b.commitTrackedSymlink(repo, rel, outside);
      expect(linked).not.toBe(commit);
      expect(b.git(repo, ['ls-tree', linked, '--', rel])).toMatch(/^120000 blob /);
      expect(b.git(repo, ['cat-file', '-p', `${linked}:${rel}`])).toBe(outside);
      expect(b.git(repo, ['status', '--porcelain'])).toBe('');
    }
  });

  it('plants a symlink to a sentinel file outside every tree', () => {
    b = createBenchFixtureBuilder();
    const { dir } = b.makeRepository('bench-escape');
    const link = join(dir, 'leak.md');
    const { outsideFile, sentinel } = b.plantEscapeLink(link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(outsideFile));
    expect(relative(realpathSync(dir), realpathSync(outsideFile)).startsWith('..')).toBe(true);
    expect(readFileSync(outsideFile, 'utf8')).toBe(sentinel);
  });
});

describe('the bench temp roots', () => {
  it('hands a constructed env whose home, app home and config root resolve to their own temp dirs, with no INIT_CWD', () => {
    vi.stubEnv('INIT_CWD', process.cwd());
    roots = createBenchRoots();
    const env = roots.env();
    expect(env.INIT_CWD).toBeUndefined();
    expect(resolveAppHome(env, '/no-such-os-home')).toBe(roots.appHome);
    expect(userConfigRootFrom(env, '/no-such-os-home')).toBe(roots.configDir);
    expect(env.HOME).toBe(roots.home);
    expect(new Set([roots.home, roots.appHome, roots.configDir]).size).toBe(3);
    expect(existsSync(join(roots.appHome, '.agent-terminal'))).toBe(false);
    expect(roots.env({ INIT_CWD: '/x' }).INIT_CWD).toBe('/x');
  });

  it('points the process\'s own home and config root at the temp roots while the test runs, and restores them', () => {
    const before = { home: homedir(), config: userConfigRoot() };
    roots = createBenchRoots();
    expect(homedir()).toBe(roots.home);
    expect(userConfigRoot()).toBe(roots.configDir);
    expect(resolveAppHome(process.env, homedir())).toBe(roots.appHome);
    roots.cleanup();
    roots = undefined;
    expect({ home: homedir(), config: userConfigRoot() }).toEqual(before);
  });

  it('copies the shipped loops-v2 into a bundle the test can edit without touching the checkout', () => {
    roots = createBenchRoots();
    const def = join('feature-dev-v3', 'plan-goal-loop', 'plan-goal-loop.yaml');
    const shipped = join(process.cwd(), 'example', 'loops-v2', def);
    const copy = join(resolveExampleLoopsV2Dir(roots.bundle), def);
    expect(readFileSync(copy, 'utf8')).toBe(readFileSync(shipped, 'utf8'));
    writeFileSync(copy, 'edited\n');
    expect(readFileSync(shipped, 'utf8')).not.toBe('edited\n');
  });
});
