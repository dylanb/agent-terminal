import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discover, readArtifact, emptyTree, pathWithin, warmBaseRef, WARM_RETRY_MS, __resetBaseRefState } from '../../src/main/artifactTree';
import { isUnderAppStateDir } from '../../src/main/appStateDirs';
import {
  seedLoopArtifacts,
  seedAppStateFiles,
  plantLoopLeafSymlink,
  plantAppStateParentSymlink,
  CAN_SYMLINK,
  LOOP_DIR_REL,
  type LoopArtifactPaths,
  type AppStateFilePaths,
} from '../helpers/loopArtifacts';
import type { ArtifactNode } from '../../src/shared/ipc';

// The path-escape guard (§20.2).
describe('pathWithin — escape guard', () => {
  it('accepts the root itself and paths under it', () => {
    expect(pathWithin('/repo', '/repo')).toBe(true);
    expect(pathWithin('/repo', '/repo/src/a.ts')).toBe(true);
  });
  it('rejects siblings and parent escapes', () => {
    expect(pathWithin('/repo', '/other')).toBe(false);
    expect(pathWithin('/repo', '/repo-2/a.ts')).toBe(false);
    expect(pathWithin('/repo/src', '/repo/secret')).toBe(false);
  });
  it('accepts an in-root dir whose name merely starts with .. (only a leading .. SEGMENT escapes)', () => {
    expect(pathWithin('/repo', '/repo/..abc/file.ts')).toBe(true);
  });
  it('handles the filesystem root without the // double-separator bug', () => {
    expect(pathWithin('/', '/etc')).toBe(true);
    expect(pathWithin('/', '/')).toBe(true);
  });
});

// Real git, real filesystem — no mocks (CLAUDE.md). Discovery: §20.1.

const git = (args: string[], cwd: string): string => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** Flatten a tree to "relPath" leaves for order-independent assertions. */
function fileRelPaths(nodes: ArtifactNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: ArtifactNode[]): void => {
    for (const n of ns) {
      if (n.kind === 'file') out.push(n.relPath);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}
function findFile(nodes: ArtifactNode[], relPath: string): ArtifactNode | undefined {
  let found: ArtifactNode | undefined;
  const walk = (ns: ArtifactNode[]): void => {
    for (const n of ns) {
      if (n.kind === 'file' && n.relPath === relPath) found = n;
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return found;
}

describe('artifact discovery (§20.1 / D8 — real git)', () => {
  let repo: string;
  let plain: string;
  let loop: LoopArtifactPaths;
  let appState: AppStateFilePaths;

  beforeEach(() => {
    __resetBaseRefState(); // isolate the process-lifetime base caches explicitly, not by temp-dir luck
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'art-repo-')));
    git(['init', '-q'], repo);
    git(['config', 'user.email', 't@t'], repo);
    git(['config', 'user.name', 'T'], repo);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'committed.md'), '# Committed\n\nbody');
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'init'], repo);
    writeFileSync(join(repo, 'committed.md'), '# Committed\n\nbody changed');
    writeFileSync(join(repo, 'untracked.txt'), 'scratch');
    // Residual state from the retired .agent-loop/ engine (#126): must NOT surface or carry the loop tag.
    mkdirSync(join(repo, '.agent-loop'), { recursive: true });
    writeFileSync(join(repo, '.agent-loop', 'plan.md'), '# Plan\n');
    // The in-terminal loop engine's working tree (§27) under .agent-terminal/loop/ (a depth-0 run-state
    // file plus nested artifacts/reports/consolidate) is what the viewer must surface as loop provenance;
    // the app's own state files directly under .agent-terminal/ must stay hidden. Both come from the
    // single-source fixtures so the fixture and the code under test resolve the identical paths.
    loop = seedLoopArtifacts(repo);
    appState = seedAppStateFiles(repo);

    plain = realpathSync(mkdtempSync(join(tmpdir(), 'art-plain-')));
    mkdirSync(join(plain, 'docs'), { recursive: true });
    writeFileSync(join(plain, 'readme.md'), '# Readme');
    writeFileSync(join(plain, 'docs', 'note.txt'), 'note');
    // Dotfiles/dirs that merely *start with* ".git" must not be mistaken for the literal .git dir.
    writeFileSync(join(plain, '.gitignore'), 'node_modules\n');
    mkdirSync(join(plain, '.github'), { recursive: true });
    writeFileSync(join(plain, '.github', 'ci.yml'), 'name: ci\n');
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(plain, { recursive: true, force: true });
  });

  // AC1 (#126): the in-terminal loop engine's tree under .agent-terminal/loop/ surfaces in curated — the
  // depth-0 run-state file AND the files nested in artifacts/reports/consolidate (the loop tree "at any depth").
  it('curated scope surfaces .agent-terminal/loop files (∪ working-tree changes), excluding unchanged committed files', () => {
    const tree = discover(repo, 'curated');
    expect(tree.isRepo).toBe(true);
    expect(tree.root).toBe(repo);
    const files = fileRelPaths(tree.nodes);
    expect(files).toEqual(expect.arrayContaining(['committed.md', 'untracked.txt', ...loop.all]));
    expect(files).not.toContain('src/a.ts'); // committed, unchanged → not curated
  });

  // AC1 complementary (green pre-change — readArtifact path-confines and reads any in-root file
  // independent of discovery; the RED evidence is the curated LISTING above, not this readback).
  it('reads a surfaced loop artifact by its .agent-terminal/loop/ relative path', () => {
    expect(readArtifact(repo, loop.plan)?.body).toContain('# Loop plan');
  });

  // AC2 (#126): surfaced loop files carry the loop provenance tag and ONLY that — not `changed` (the loop
  // tree is itself under the app-state-excluded .agent-terminal/, so it is dropped from `changed`/`pr`).
  it('tags provenance: changed for working-tree edits, loop (only) for .agent-terminal/loop files', () => {
    const tree = discover(repo, 'curated');
    expect(findFile(tree.nodes, 'committed.md')?.provenance).toContain('changed');
    expect(findFile(tree.nodes, loop.plan)?.provenance).toEqual(['loop']);
    expect(findFile(tree.nodes, loop.runState)?.provenance).toEqual(['loop']);
  });

  // AC3 (#126): loop provenance no longer depends on the retired .agent-loop/ dir — a residual
  // .agent-loop/plan.md (seeded in beforeEach) never appears and is never loop-tagged, while the
  // .agent-terminal/loop tree still surfaces independent of it.
  it('does not surface or loop-tag residual .agent-loop/ files (loop provenance derives from .agent-terminal/loop)', () => {
    const tree = discover(repo, 'curated');
    expect(fileRelPaths(tree.nodes)).not.toContain('.agent-loop/plan.md');
    expect(findFile(tree.nodes, '.agent-loop/plan.md')).toBeUndefined();
    expect(findFile(tree.nodes, loop.report)?.provenance).toEqual(['loop']);
  });

  // AC4 (#126) — untracked-collapse fixture: app state directly under .agent-terminal/ (flow-state.yaml,
  // todos.json, monitor-events.json, audit-pointer.yaml) never surfaces in EITHER scope, including the
  // collapsed `?? .agent-terminal/` node git emits for the otherwise-untracked dir. Only the loop subtree
  // under .agent-terminal/loop/ is allowed through.
  it('excludes app state under .agent-terminal/ from both scopes (untracked-collapse fixture)', () => {
    for (const scope of ['curated', 'repo'] as const) {
      const files = fileRelPaths(discover(repo, scope).nodes);
      const appStateNonLoop = files.filter((f) => isUnderAppStateDir(f) && !f.startsWith(`${LOOP_DIR_REL}/`));
      expect(appStateNonLoop).toEqual([]);
    }
  });

  // AC4 (#126) — committed-app-state fixture (disjoint from the collapse case: committing un-collapses the
  // dir): an app-state file committed on the branch over the base enters the `pr` diff, but the filter
  // drops it before it can surface tagged pr.
  it('excludes a committed app-state file under .agent-terminal/ from the pr set (absent + untagged)', () => {
    const base = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim();
    git(['checkout', '-q', '-b', 'feature'], repo);
    git(['add', '-f', appState.flowState], repo);
    git(['commit', '-q', '-m', 'commit app state'], repo);
    const tree = discover(repo, 'curated', { baseRef: () => base });
    expect(fileRelPaths(tree.nodes)).not.toContain(appState.flowState);
    expect(findFile(tree.nodes, appState.flowState)).toBeUndefined();
  });

  // §20.1: curated is the SUPERSET — files changed in the working tree (`changed`) ∪ files a branch
  // commits over its PR base (`pr`) ∪ agent-loop files. `baseRef` names the PR base branch; the merge-
  // base with HEAD is what the branch is diffed against (injected here so the suite stays offline).
  it('curated is the superset: committed-but-in-PR files are included and tagged pr', () => {
    const base = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim();
    git(['checkout', '-q', '-b', 'feature'], repo);
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const f = 1;\n');
    git(['add', 'src/feature.ts'], repo); // NOT `git add .` — keep committed.md's edit uncommitted
    git(['commit', '-q', '-m', 'feat: add feature.ts'], repo);
    // committed.md still carries the uncommitted working-tree edit from beforeEach.
    const tree = discover(repo, 'curated', { baseRef: () => base });
    const files = fileRelPaths(tree.nodes);
    expect(files).toContain('src/feature.ts'); // committed on the branch, absent from the base
    expect(files).toContain('committed.md'); // uncommitted working-tree edit
    expect(findFile(tree.nodes, 'src/feature.ts')?.provenance).toContain('pr');
    expect(findFile(tree.nodes, 'committed.md')?.provenance).toContain('changed');
  });

  it('a file both committed-in-PR and further edited carries both pr and changed', () => {
    const base = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim();
    git(['checkout', '-q', '-b', 'feature'], repo);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\nexport const y = 2;\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'add y'], repo);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n');
    const prov = findFile(discover(repo, 'curated', { baseRef: () => base }).nodes, 'src/a.ts')?.provenance ?? [];
    expect(prov).toEqual(expect.arrayContaining(['pr', 'changed']));
  });

  it('does not tag base-branch files as pr (only what the branch adds over the merge-base)', () => {
    const base = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim();
    git(['checkout', '-q', '-b', 'feature'], repo);
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const f = 1;\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'feat'], repo);
    // src/a.ts is on the base branch, unchanged on the branch → neither changed nor pr.
    expect(fileRelPaths(discover(repo, 'curated', { baseRef: () => base }).nodes)).not.toContain('src/a.ts');
  });

  it('with no resolvable base, curated stays working-tree ∪ loop (no pr tags)', () => {
    const tree = discover(repo, 'curated', { baseRef: () => null });
    expect(fileRelPaths(tree.nodes)).not.toContain('src/a.ts');
    expect(JSON.stringify(tree.nodes)).not.toContain('"pr"');
  });

  // The sync base memo must not cache a null (unresolvable) result — else a default branch that appears
  // mid-session would never be picked up until restart. Only a resolved base is cached.
  it('re-resolves the base when a default branch appears mid-session (never caches a null base)', () => {
    git(['branch', '-M', 'topic'], repo); // no origin/HEAD, no main/master → base unresolvable
    discover(repo, 'curated'); // must NOT cache the null base for (repo, topic)
    git(['branch', 'main'], repo); // a default branch now exists, at topic's current tip
    writeFileSync(join(repo, 'src', 'later.ts'), 'export const l = 1;\n');
    git(['add', 'src/later.ts'], repo);
    git(['commit', '-q', '-m', 'later'], repo); // committed on topic over main
    expect(findFile(discover(repo, 'curated').nodes, 'src/later.ts')?.provenance).toContain('pr');
  });

  it('a file deleted on the branch is not listed or tagged pr (deletions excluded)', () => {
    const base = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim();
    git(['checkout', '-q', '-b', 'feature'], repo);
    git(['rm', '-q', 'src/a.ts'], repo); // a.ts is on the base branch; delete it here
    git(['commit', '-q', '-m', 'rm a.ts'], repo);
    const tree = discover(repo, 'curated', { baseRef: () => base });
    expect(fileRelPaths(tree.nodes)).not.toContain('src/a.ts'); // a deleted file has no current content
    expect(findFile(tree.nodes, 'src/a.ts')).toBeUndefined();
  });

  // §20.2: the code viewer's changed lines are relative to the PR base, so a line committed on the
  // branch highlights even when the working tree is clean vs HEAD.
  it('changedLines mark lines a committed-in-PR code file adds over the base (not just vs HEAD)', () => {
    const base = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim();
    git(['checkout', '-q', '-b', 'feature'], repo);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\nexport const y = 2;\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'add y'], repo);
    // Clean vs HEAD, but line 2 is new vs the base.
    expect(readArtifact(repo, 'src/a.ts', { baseRef: () => base })?.changedLines).toEqual([2]);
  });

  it('changedLines are the superset of committed-in-PR and uncommitted edits', () => {
    const base = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo).trim();
    git(['checkout', '-q', '-b', 'feature'], repo);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\nexport const y = 2;\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'add y'], repo);
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n');
    expect(readArtifact(repo, 'src/a.ts', { baseRef: () => base })?.changedLines).toEqual([2, 3]);
  });

  it('with no resolvable base, changedLines fall back to the vs-HEAD working-tree diff', () => {
    // a.ts committed as one line; append two → vs HEAD lines 2,3 are new.
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n');
    expect(readArtifact(repo, 'src/a.ts', { baseRef: () => null })?.changedLines).toEqual([2, 3]);
  });

  // §20.1: the synchronous discovery path resolves the base from LOCAL refs only (never a network
  // call) — origin/HEAD, else a conventional default — so the main thread never blocks on gh.
  it('the synchronous base resolves from origin/HEAD without any network call', () => {
    git(['branch', '-M', 'main'], repo);
    const head = git(['rev-parse', 'HEAD'], repo).trim();
    git(['update-ref', 'refs/remotes/origin/main', head], repo);
    git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], repo);
    git(['checkout', '-q', '-b', 'feature'], repo);
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const f = 1;\n');
    git(['add', 'src/feature.ts'], repo);
    git(['commit', '-q', '-m', 'feat'], repo);
    // No baseRef injected, no gh reachable in a temp repo → base is origin/main via the symbolic-ref.
    expect(findFile(discover(repo, 'curated').nodes, 'src/feature.ts')?.provenance).toContain('pr');
  });

  // §20.1: the real PR base (which may target a non-default branch) is refined off the synchronous
  // path by warmBaseRef; it re-points the memoized base and signals when the tree must re-pull.
  it('warmBaseRef refines the base to the real gh PR base, dropping default-branch files from the tree', async () => {
    git(['branch', '-M', 'main'], repo); // default branch = main
    git(['checkout', '-q', '-b', 'develop'], repo); // develop adds onlydev.ts over main
    writeFileSync(join(repo, 'src', 'onlydev.ts'), 'export const d = 1;\n');
    git(['add', 'src/onlydev.ts'], repo);
    git(['commit', '-q', '-m', 'dev'], repo);
    git(['checkout', '-q', '-b', 'feature'], repo); // feature branches from develop
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const f = 1;\n');
    git(['add', 'src/feature.ts'], repo);
    git(['commit', '-q', '-m', 'feat'], repo);
    // Sync path resolves the local default (main), so onlydev.ts looks like part of the PR (it isn't).
    expect(findFile(discover(repo, 'curated').nodes, 'src/onlydev.ts')?.provenance).toContain('pr');
    // The real PR base is develop; warming with it corrects the tree and signals the change.
    expect(await warmBaseRef(repo, { git, prBaseName: async () => 'develop' })).toBe(true);
    expect(findFile(discover(repo, 'curated').nodes, 'src/onlydev.ts')?.provenance).toBeUndefined();
    expect(findFile(discover(repo, 'curated').nodes, 'src/feature.ts')?.provenance).toContain('pr');
  });

  it('warmBaseRef reports no change when the gh base already matches the local base', async () => {
    git(['branch', '-M', 'main'], repo);
    git(['checkout', '-q', '-b', 'feature'], repo);
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const f = 1;\n');
    git(['add', 'src/feature.ts'], repo);
    git(['commit', '-q', '-m', 'feat'], repo);
    discover(repo, 'curated'); // resolves + caches the local base 'main'
    expect(await warmBaseRef(repo, { git, prBaseName: async () => 'main' })).toBe(false);
  });

  it('warmBaseRef never caches a failed gh lookup — the local base still resolves afterward', async () => {
    git(['branch', '-M', 'main'], repo);
    git(['checkout', '-q', '-b', 'feature'], repo);
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const f = 1;\n');
    git(['add', 'src/feature.ts'], repo);
    git(['commit', '-q', '-m', 'feat'], repo);
    expect(await warmBaseRef(repo, { git, prBaseName: async () => { throw new Error('offline'); } })).toBe(false);
    // The transient failure left no cached base → the synchronous path still resolves 'main'.
    expect(findFile(discover(repo, 'curated').nodes, 'src/feature.ts')?.provenance).toContain('pr');
  });

  // A RESOLVED gh base is fetched at most once per (root, branch) — a repeat warm (e.g. from every watch
  // burst after a checkout) must not re-spawn it. (An unresolved attempt is retried under the throttle —
  // see the retry test below.)
  it('warmBaseRef resolves the gh base at most once per branch (no repeat spawn)', async () => {
    git(['branch', '-M', 'main'], repo);
    git(['checkout', '-q', '-b', 'feature'], repo);
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const f = 1;\n');
    git(['add', 'src/feature.ts'], repo);
    git(['commit', '-q', '-m', 'feat'], repo);
    let calls = 0;
    const prBaseName = async (): Promise<string> => { calls++; return 'main'; };
    await warmBaseRef(repo, { git, prBaseName });
    await warmBaseRef(repo, { git, prBaseName });
    expect(calls).toBe(1);
  });

  it('warmBaseRef leaves the local base intact when the gh base name is absent locally', async () => {
    git(['branch', '-M', 'main'], repo);
    git(['checkout', '-q', '-b', 'feature'], repo);
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const f = 1;\n');
    git(['add', 'src/feature.ts'], repo);
    git(['commit', '-q', '-m', 'feat'], repo);
    // gh names a branch not present in the local clone → no overwrite, no change signalled.
    expect(await warmBaseRef(repo, { git, prBaseName: async () => 'no-such-ref' })).toBe(false);
    expect(findFile(discover(repo, 'curated').nodes, 'src/feature.ts')?.provenance).toContain('pr');
  });

  it('warmBaseRef prefers the remote-tracking origin/<base> over a divergent local branch of the same name', async () => {
    git(['branch', '-M', 'main'], repo);
    const initSha = git(['rev-parse', 'HEAD'], repo).trim();
    git(['checkout', '-q', '-b', 'develop'], repo); // local develop adds onlydev.ts over init
    writeFileSync(join(repo, 'src', 'onlydev.ts'), 'export const d = 1;\n');
    git(['add', 'src/onlydev.ts'], repo);
    git(['commit', '-q', '-m', 'dev'], repo);
    git(['update-ref', 'refs/remotes/origin/develop', initSha], repo); // origin/develop lags at init
    git(['checkout', '-q', '-b', 'feature'], repo); // feature branches from local develop
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const f = 1;\n');
    git(['add', 'src/feature.ts'], repo);
    git(['commit', '-q', '-m', 'feat'], repo);
    expect(await warmBaseRef(repo, { git, prBaseName: async () => 'develop' })).toBe(true);
    // Base is origin/develop (= init), not local develop: onlydev.ts (added on local develop) is tagged pr.
    expect(findFile(discover(repo, 'curated').nodes, 'src/onlydev.ts')?.provenance).toContain('pr');
  });

  // A resolved base is deduped for the session, but an UNRESOLVED attempt (no PR yet / gh offline) must
  // be retried — throttled to the WARM_RETRY_MS boundary — so a PR opened or connectivity restored
  // mid-session is still picked up.
  it('warmBaseRef retries an unresolved branch at the throttle boundary, then dedups once resolved', async () => {
    git(['branch', '-M', 'main'], repo);
    git(['checkout', '-q', '-b', 'feature'], repo);
    writeFileSync(join(repo, 'src', 'feature.ts'), 'export const f = 1;\n');
    git(['add', 'src/feature.ts'], repo);
    git(['commit', '-q', '-m', 'feat'], repo);
    let t = 1000;
    let calls = 0;
    // No PR at first (null); once a PR is opened the lookup resolves to 'main'.
    const prBaseName = async (): Promise<string | null> => { calls++; return calls >= 3 ? 'main' : null; };
    const now = (): number => t;
    await warmBaseRef(repo, { git, prBaseName, now }); // attempt 1: no PR, records the attempt time
    expect(calls).toBe(1);
    t += WARM_RETRY_MS - 1; // just inside the window
    await warmBaseRef(repo, { git, prBaseName, now }); // still throttled → no spawn
    expect(calls).toBe(1);
    t += 1; // exactly at the window (delta === WARM_RETRY_MS; the `<` boundary lets it through)
    await warmBaseRef(repo, { git, prBaseName, now }); // attempt 2: retries, still no PR
    expect(calls).toBe(2);
    t += WARM_RETRY_MS;
    await warmBaseRef(repo, { git, prBaseName, now }); // attempt 3: PR now resolves
    expect(calls).toBe(3);
    await warmBaseRef(repo, { git, prBaseName, now }); // resolved → deduped, no further spawn
    expect(calls).toBe(3);
  });

  // The dedup key is (root, branch): a checkout to a new branch must re-warm — the branch component is
  // what makes warm-on-branch-switch work (a root-only key would silently break it).
  it('warmBaseRef re-warms after a branch switch (dedup is per branch, not per repo)', async () => {
    git(['branch', '-M', 'main'], repo);
    git(['checkout', '-q', '-b', 'feature-a'], repo);
    writeFileSync(join(repo, 'src', 'a-feat.ts'), 'export const a = 1;\n');
    git(['add', 'src/a-feat.ts'], repo);
    git(['commit', '-q', '-m', 'a'], repo);
    let calls = 0;
    const prBaseName = async (): Promise<string> => { calls++; return 'main'; };
    await warmBaseRef(repo, { git, prBaseName }); // warms feature-a
    expect(calls).toBe(1);
    git(['checkout', '-q', '-b', 'feature-b'], repo);
    await warmBaseRef(repo, { git, prBaseName }); // new (root, branch) key → re-warms
    expect(calls).toBe(2);
  });

  it('repo scope = every tracked + untracked file, built hierarchically', () => {
    const tree = discover(repo, 'repo');
    const files = fileRelPaths(tree.nodes);
    expect(files).toEqual(expect.arrayContaining(['committed.md', 'src/a.ts', 'untracked.txt']));
    const srcDir = tree.nodes.find((n) => n.kind === 'dir' && n.name === 'src');
    expect(srcDir?.children?.some((c) => c.name === 'a.ts')).toBe(true);
  });

  it('outside a git repo, discovers the whole cwd directory tree (no provenance)', () => {
    const tree = discover(plain, 'curated');
    expect(tree.isRepo).toBe(false);
    expect(tree.root).toBe(plain);
    expect(fileRelPaths(tree.nodes)).toEqual(expect.arrayContaining(['readme.md', 'docs/note.txt']));
    expect(findFile(tree.nodes, 'readme.md')?.provenance).toBeUndefined();
  });

  it('outside a git repo, includes dotfiles like .gitignore and .github/ (only the literal .git dir is skipped)', () => {
    const tree = discover(plain, 'curated');
    const files = fileRelPaths(tree.nodes);
    expect(files).toEqual(expect.arrayContaining(['.gitignore', '.github/ci.yml']));
  });

  // The viewer:tree handler returns this for an invalid request rather than null, which would
  // crash the renderer's `data.root` read.
  it('emptyTree() is a valid, empty ArtifactTree (the invalid-request fallback)', () => {
    expect(emptyTree('/some/cwd')).toEqual({ root: '/some/cwd', isRepo: false, scope: 'curated', nodes: [] });
    expect(emptyTree('/x', 'repo').scope).toBe('repo');
  });

  it('reads a file by tree-relative path, classifying markdown vs code', () => {
    expect(readArtifact(repo, 'committed.md')).toMatchObject({ kind: 'markdown', name: 'committed.md' });
    const code = readArtifact(repo, 'src/a.ts');
    expect(code).toMatchObject({ kind: 'code', lang: 'typescript' });
    expect(code?.body).toContain('export const x = 1;');
  });

  it('refuses to read outside the discovery root (path-escape guard)', () => {
    expect(readArtifact(repo, '../../etc/passwd')).toBeNull();
    expect(readArtifact(repo, 'does-not-exist.md')).toBeNull();
  });

  it('refuses to follow an in-root symlink that points outside the discovery root', () => {
    // An in-root symlink targeting an outside file passes the lexical guard; the read must still
    // refuse it (resolve real paths, not the literal path).
    const outside = mkdtempSync(join(tmpdir(), 'art-outside-'));
    writeFileSync(join(outside, 'secret.md'), '# secret');
    try {
      symlinkSync(join(outside, 'secret.md'), join(plain, 'link.md'));
    } catch {
      return; // platform without symlink permission — skip
    }
    expect(readArtifact(plain, 'link.md')).toBeNull();
    rmSync(outside, { recursive: true, force: true });
  });

  it('reads an in-root symlink that targets an in-root file (stat/read via the validated real path)', () => {
    // A legitimate in-root symlink must still read its target's content — regression pin for the
    // TOCTOU abs→real-path switch.
    writeFileSync(join(plain, 'target.md'), '# real target body');
    try {
      symlinkSync(join(plain, 'target.md'), join(plain, 'alias.md'));
    } catch {
      return; // platform without symlink permission — skip
    }
    expect(readArtifact(plain, 'alias.md')?.body).toBe('# real target body');
  });

  // §20.2: a code file carries the current-file line numbers that differ from HEAD — added or
  // modified lines only (not a diff; deletions leave no current line to mark).
  it('marks added lines of a modified code file by their current-file position', () => {
    // a.ts was committed as a single line; append two more, leaving line 1 untouched.
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 1;\nexport const y = 2;\nexport const z = 3;\n');
    expect(readArtifact(repo, 'src/a.ts')?.changedLines).toEqual([2, 3]);
  });

  it('marks a modified line in place, not as a deletion', () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const x = 99;\n');
    expect(readArtifact(repo, 'src/a.ts')?.changedLines).toEqual([1]);
  });

  it('marks every line of an untracked (entirely new) code file', () => {
    writeFileSync(join(repo, 'src', 'fresh.ts'), 'a\nb\nc\n');
    expect(readArtifact(repo, 'src/fresh.ts')?.changedLines).toEqual([1, 2, 3]);
  });

  it('leaves changedLines unset for an unchanged code file', () => {
    expect(readArtifact(repo, 'src/a.ts')?.changedLines).toBeUndefined();
  });

  it('does not compute changed lines for markdown files', () => {
    expect(readArtifact(repo, 'committed.md')?.changedLines).toBeUndefined();
  });

  it('outside a git repo, code files carry no changed-line info', () => {
    writeFileSync(join(plain, 'free.ts'), 'a\nb\n');
    expect(readArtifact(plain, 'free.ts')?.changedLines).toBeUndefined();
  });
});

// #126 (§20.1): the common case — a repo with NO .agent-terminal/loop/ at all. discover() must not
// throw when the loop dir is absent (nearly every real repo has none); absence stays silent and yields
// an empty loop set.
describe('artifact discovery — no .agent-terminal/loop present (§20.1, #126)', () => {
  let repo: string;

  beforeEach(() => {
    __resetBaseRefState();
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'art-noloop-')));
    git(['init', '-q'], repo);
    git(['config', 'user.email', 't@t'], repo);
    git(['config', 'user.name', 'T'], repo);
    writeFileSync(join(repo, 'committed.md'), '# Committed\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'init'], repo);
    writeFileSync(join(repo, 'committed.md'), '# Committed\n\nchanged');
    writeFileSync(join(repo, 'untracked.txt'), 'scratch');
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('surfaces working-tree changes and no loop nodes when the loop dir is absent', () => {
    const tree = discover(repo, 'curated'); // must not throw for a repo with no .agent-terminal/loop/
    const files = fileRelPaths(tree.nodes);
    expect(files).toEqual(expect.arrayContaining(['committed.md', 'untracked.txt']));
    expect(files.some((f) => f.startsWith('.agent-terminal/'))).toBe(false);
  });
});

// #126 / CWE-59/22: discovery resolves <repo>/.agent-terminal/loop through the filesystem, so a symlink
// planted at the loop leaf or its `.agent-terminal` parent must NOT let the walk enumerate an out-of-repo
// subtree into the viewer tree. The loop dir sits in untrusted working-tree content, so confinement matches
// how the loop engine itself reads the area (appLoopState.ts: resolveJail + confinedRealPath).
describe.skipIf(!CAN_SYMLINK)('artifact discovery — loop-dir symlink confinement (CWE-59/22, #126)', () => {
  let repo: string;
  let external: string;

  beforeEach(() => {
    __resetBaseRefState();
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'art-confine-repo-')));
    git(['init', '-q'], repo);
    git(['config', 'user.email', 't@t'], repo);
    git(['config', 'user.name', 'T'], repo);
    // An out-of-repo tree whose file names must never leak into the viewer as .agent-terminal/loop/* nodes.
    external = realpathSync(mkdtempSync(join(tmpdir(), 'art-confine-ext-')));
    mkdirSync(join(external, 'sub'), { recursive: true });
    writeFileSync(join(external, 'escaped-secret.txt'), 'SECRET\n');
    writeFileSync(join(external, 'sub', 'deep.txt'), 'DEEP\n');
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  });

  it('refuses a loop LEAF symlinked out-of-repo — external files never surface or carry the loop tag', () => {
    plantLoopLeafSymlink(repo, external); // .agent-terminal/loop -> external (the final segment IS the link)
    const files = fileRelPaths(discover(repo, 'curated').nodes);
    expect(files).not.toContain('.agent-terminal/loop/escaped-secret.txt');
    expect(files).not.toContain('.agent-terminal/loop/sub/deep.txt');
    expect(files.some((f) => f.startsWith('.agent-terminal/loop/'))).toBe(false);
  });

  it('refuses a .agent-terminal PARENT symlinked out-of-repo even with a real loop/ behind it', () => {
    mkdirSync(join(external, 'loop'), { recursive: true }); // a REAL loop/ inside the external target
    writeFileSync(join(external, 'loop', 'run-state.yaml'), 'status: running\n');
    plantAppStateParentSymlink(repo, external); // .agent-terminal -> external (the leaf-only-lstat miss)
    const files = fileRelPaths(discover(repo, 'curated').nodes);
    expect(files).not.toContain('.agent-terminal/loop/run-state.yaml');
    expect(files.some((f) => f.startsWith('.agent-terminal/loop/'))).toBe(false);
  });
});
