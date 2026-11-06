// `--validate-flow`'s check, called directly: which file a loop failure is blamed on, and where a flow's loops
// resolve for each place its folder can sit.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loopDefRelPath } from '../../src/main/appLoopPaths';
import { resolveLoopDefV2, type LoopDefV2Context, type LoopDefV2Tiers } from '../../src/main/loopDefV2';
import { userConfigLoopsDir } from '../../src/main/userConfig';
import { runValidateFlow } from '../../src/main/validateFlow';
import { fixtureResolves, flowLocations, writeFlow, writeLoopDef, writeLoopRegistry, type FlowSpec } from '../helpers/flowFixtures';
import { passOutcome, problemOutcome, type RunResult } from '../helpers/validateOutcome';

const PASSED = { status: 0, oneLine: true, okLine: true, output: expect.any(String) };
const naming = (item: string): unknown => ({ status: 1, oneLine: true, prefixed: true, problem: expect.stringContaining(item), output: expect.any(String) });

const loopFlow = (name: string, loops: readonly string[]): FlowSpec => ({
  name,
  steps: loops.map((loop, i) => ({ id: `step-${i + 1}`, kind: 'loop' as const, loop })),
});

let root: string;
const dir = (name: string): string => {
  const abs = join(root, name);
  mkdirSync(abs, { recursive: true });
  return abs;
};
let appHome: string;
let configDir: string;
let appBundleTree: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'validate-flow-tiers-')));
  appHome = dir('app-home');
  configDir = dir('claude-config');
  appBundleTree = dir('installed-app');
  mkdirSync(flowLocations.bundledLoops(appBundleTree), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const operatorLoops = (): string => flowLocations.operatorLoops(configDir);

const appTiers = (): LoopDefV2Tiers => ({
  operator: operatorLoops(),
  appBundled: flowLocations.bundledLoops(appBundleTree),
  retired: userConfigLoopsDir(configDir),
});

/** The loop context the app hands a run of a repository flow in `repo`. */
const appContext = (repo: string, flow: string): LoopDefV2Context => ({ tiers: appTiers(), repoDir: repo, flow });

const validateIn = (folder: string, cwd: string): RunResult => {
  const { exitCode, stdout, stderr } = runValidateFlow([folder], { cwd: () => cwd, appHome, loopTiers: appTiers() });
  return { status: exitCode, signal: null, stdout, stderr };
};

/** A loop that only `repo`'s own `.agent-loop.yaml` resolves. */
const overrideLoop = (repo: string, name: string): void => {
  const defFile = writeLoopDef(join(repo, 'own-loops'), name);
  writeLoopRegistry(repo, { [name]: relative(repo, defFile) });
};

/** Runs `folder` naming only `positive`, then naming `positive` and `mustFail`, from each of `cwds`. The first run
 *  must pass and the second must print exactly `mustFail`'s flow.yaml line. */
const passesThenNamesOnly = (folder: string, positive: readonly string[], mustFail: string, cwds: readonly string[], flowName = 'f'): void => {
  for (const cwd of cwds) {
    writeFlow(folder, loopFlow(flowName, positive));
    expect.soft({ cwd, ...passOutcome(validateIn(folder, cwd)) }).toEqual({ cwd, ...PASSED });
    const flowFile = writeFlow(folder, loopFlow(flowName, [...positive, mustFail]));
    expect.soft({ cwd, ...problemOutcome(validateIn(folder, cwd), realpathSync(flowFile)) }).toEqual({ cwd, ...(naming(mustFail) as object) });
  }
};

describe('which file a loop failure is blamed on', () => {
  it('a loop definition that links out of its tier root is a flow.yaml problem naming the loop, and prints no outside path', () => {
    const repo = dir('repo');
    const outside = writeLoopDef(dir('stray-loops'), 'linked-loop');
    const inTier = join(operatorLoops(), loopDefRelPath('linked-loop'));
    mkdirSync(dirname(inTier), { recursive: true });
    symlinkSync(outside, inTier);
    const folder = flowLocations.repoCatalogEntry(repo, 'f');
    const flowFile = writeFlow(folder, loopFlow('f', ['linked-loop']));
    const verdict = resolveLoopDefV2('linked-loop', appContext(repo, 'f'));
    const never = resolveLoopDefV2('never-written-loop', appContext(repo, 'f'));
    if (verdict.ok || never.ok || verdict.reason === never.reason.split('never-written-loop').join('linked-loop')) {
      throw new Error('fixture: the app does not refuse the linked definition as escaping its tier');
    }
    const outcome = problemOutcome(validateIn(folder, repo), realpathSync(flowFile));
    expect.soft(outcome).toEqual(naming('linked-loop'));
    expect.soft(outcome.problem).not.toContain(dirname(outside));
  });

  it('a repository override that maps a loop out of the repository is a flow.yaml problem naming the loop, and prints no outside path', () => {
    const repo = dir('repo');
    const outside = writeLoopDef(dir('outside-loops'), 'escaping-loop');
    writeLoopRegistry(repo, { 'escaping-loop': relative(repo, outside) });
    const folder = flowLocations.repoCatalogEntry(repo, 'f');
    const flowFile = writeFlow(folder, loopFlow('f', ['escaping-loop']));
    fixtureResolves('escaping-loop', appContext(repo, 'f'), false);
    const outcome = problemOutcome(validateIn(folder, repo), realpathSync(flowFile));
    expect.soft(outcome).toEqual(naming('escaping-loop'));
    expect.soft(outcome.problem).not.toContain(dirname(outside));
  });

  it('a loop definition that is reached but cannot be read is a problem naming that definition, with the resolver\'s reason', () => {
    const repo = dir('repo');
    const defFile = join(operatorLoops(), loopDefRelPath('unreadable-loop'));
    mkdirSync(defFile, { recursive: true });
    const folder = flowLocations.repoCatalogEntry(repo, 'f');
    writeFlow(folder, loopFlow('f', ['unreadable-loop']));
    const verdict = resolveLoopDefV2('unreadable-loop', appContext(repo, 'f'));
    if (verdict.ok) throw new Error('fixture: the app reads a directory as a loop definition');
    expect(problemOutcome(validateIn(folder, repo), realpathSync(defFile))).toEqual(naming(verdict.reason));
  });
});

describe('a flow\'s loops resolve in the tier its folder sits in', () => {
  it('a local <repo>/.agent-terminal/ flow resolves a loop through the repository\'s override registry', () => {
    const repo = dir('repo');
    overrideLoop(repo, 'override-loop');
    passesThenNamesOnly(flowLocations.repoLocal(repo), ['override-loop'], 'nowhere-loop', [repo, dir('elsewhere')]);
  });

  it('a repository inside the app-state home keeps the repository tier', () => {
    const repo = join(appHome, 'projects', 'r');
    overrideLoop(repo, 'override-loop');
    passesThenNamesOnly(flowLocations.repoCatalogEntry(repo, 'f'), ['override-loop'], 'nowhere-loop', [repo, dir('elsewhere')]);
  });

  it('a repository flow resolves a loop held only in the operator tier', () => {
    const repo = dir('repo');
    writeLoopDef(operatorLoops(), 'operator-loop');
    passesThenNamesOnly(flowLocations.repoCatalogEntry(repo, 'f'), ['operator-loop'], 'nowhere-loop', [repo, dir('elsewhere')]);
  });

  it('the global fallback <A>/.agent-terminal/ consults no repository override, from any working directory', () => {
    overrideLoop(appHome, 'overridden-loop');
    const cwdRepo = dir('cwd-repo');
    overrideLoop(cwdRepo, 'overridden-loop');
    writeLoopDef(operatorLoops(), 'operator-loop');
    fixtureResolves('overridden-loop', appContext(appHome, 'f'), true);
    fixtureResolves('overridden-loop', appContext(cwdRepo, 'f'), true);
    passesThenNamesOnly(flowLocations.globalFallback(appHome), ['operator-loop'], 'overridden-loop', [root, cwdRepo]);
  });

  it('a global catalog flow resolves a loop held only in the app\'s bundled loop tree', () => {
    writeLoopDef(flowLocations.bundledLoops(appBundleTree), 'shipped-loop');
    fixtureResolves('shipped-loop', appContext(dir('other'), 'f'), true);
    passesThenNamesOnly(flowLocations.globalCatalogEntry(appHome, 'f'), ['shipped-loop'], 'nowhere-loop', [root]);
  });

  it('a source tree\'s example flow resolves loops in its own loops tree and not in the operator tier', () => {
    const tree = dir('tree');
    writeLoopDef(flowLocations.bundledLoops(tree), 'tree-loop');
    writeLoopDef(operatorLoops(), 'operator-only-loop');
    fixtureResolves('tree-loop', appContext(dir('other'), 'f'), false);
    fixtureResolves('operator-only-loop', appContext(dir('other'), 'f'), true);
    passesThenNamesOnly(flowLocations.bundledEntry(tree, 'f'), ['tree-loop'], 'operator-only-loop', [tree]);
  });

  it('a source tree\'s example flow consults no repository override, neither the tree\'s nor the working directory\'s', () => {
    const tree = dir('tree');
    writeLoopDef(flowLocations.bundledLoops(tree), 'tree-loop');
    overrideLoop(tree, 'tree-override-loop');
    const cwdRepo = dir('cwd-repo');
    overrideLoop(cwdRepo, 'tree-override-loop');
    fixtureResolves('tree-override-loop', appContext(tree, 'f'), true);
    fixtureResolves('tree-override-loop', appContext(cwdRepo, 'f'), true);
    passesThenNamesOnly(flowLocations.bundledEntry(tree, 'f'), ['tree-loop'], 'tree-override-loop', [tree, cwdRepo]);
  });

  describe('a loop in a flow-scoped folder resolves for the flow\'s name, not its folder id', () => {
    const scopedOperatorLoop = (): void => {
      writeLoopDef(operatorLoops(), 'scoped-loop', {}, { flow: 'scoped-flow' });
      fixtureResolves('scoped-loop', appContext(dir('other'), 'scoped-flow'), true);
      fixtureResolves('scoped-loop', appContext(dir('other'), 'entry-id'), false);
    };

    it('a repository catalog flow, in the operator tier', () => {
      const repo = dir('repo');
      scopedOperatorLoop();
      passesThenNamesOnly(flowLocations.repoCatalogEntry(repo, 'entry-id'), ['scoped-loop'], 'nowhere-loop', [repo, dir('elsewhere')], 'scoped-flow');
    });

    it('a global catalog flow, in the operator tier', () => {
      scopedOperatorLoop();
      passesThenNamesOnly(flowLocations.globalCatalogEntry(appHome, 'entry-id'), ['scoped-loop'], 'nowhere-loop', [root], 'scoped-flow');
    });

    it('a source tree\'s example flow, in its loops tree', () => {
      const tree = dir('tree');
      writeLoopDef(flowLocations.bundledLoops(tree), 'scoped-loop', {}, { flow: 'scoped-flow' });
      const bundled: LoopDefV2Context = { tiers: { operator: null, appBundled: flowLocations.bundledLoops(tree), retired: null }, repoDir: dir('other') };
      fixtureResolves('scoped-loop', { ...bundled, flow: 'scoped-flow' }, true);
      fixtureResolves('scoped-loop', { ...bundled, flow: 'entry-id' }, false);
      passesThenNamesOnly(flowLocations.bundledEntry(tree, 'entry-id'), ['scoped-loop'], 'nowhere-loop', [tree], 'scoped-flow');
    });
  });

  describe('a global or bundled flow folder that holds its own override registry does not consult it', () => {
    const folders: readonly { tier: string; folder: () => string }[] = [
      { tier: 'a global catalog flow', folder: () => flowLocations.globalCatalogEntry(appHome, 'f') },
      { tier: 'the global fallback <A>/.agent-terminal/', folder: () => flowLocations.globalFallback(appHome) },
      {
        tier: 'a source tree\'s example flow',
        folder: () => {
          const tree = dir('tree');
          writeLoopDef(flowLocations.bundledLoops(tree), 'tree-loop');
          return flowLocations.bundledEntry(tree, 'f');
        },
      },
    ];
    for (const { tier, folder: makeFolder } of folders) {
      it(`${tier} fails naming the loop its folder's registry maps`, () => {
        const folder = makeFolder();
        const defFile = writeLoopDef(folder, 'folder-loop');
        writeLoopRegistry(folder, { 'folder-loop': relative(folder, defFile) });
        const tiers = { operator: null, appBundled: dir('empty-bundle'), retired: null };
        if (!resolveLoopDefV2('folder-loop', { tiers, repoDir: folder }).ok) throw new Error('fixture: the folder\'s registry does not map folder-loop');
        const flowFile = writeFlow(folder, { name: 'f', steps: [{ id: 'step-1', kind: 'loop', loop: 'folder-loop' }] });
        expect(problemOutcome(validateIn(folder, root), realpathSync(flowFile))).toEqual(naming('folder-loop'));
      });
    }
  });
});
