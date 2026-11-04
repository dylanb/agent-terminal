// `agent-terminal --validate-flow <dir>` as the installed launcher runs it: the checker runtime of an installed
// build, in plain-Node mode, from a chosen working directory. Every test asserts only what the command prints and
// its exit status.

import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadUntrustedFlowDefinition } from '../../src/main/flow';
import { resolveCatalogEntry, type CatalogRoots } from '../../src/main/flowCatalog';
import { listCatalog } from '../../src/main/flowCatalogList';
import { FLOW_DEF_FILE } from '../../src/main/flowHome';
import { catalogRefusalReason, UNSAFE_NAME_REASON, type CatalogTier } from '../../src/main/resolveRunDefinition';
import { MAX_CATALOG_ID_LENGTH } from '../../src/shared/pathSegment';
import { flowLocations, writeFlow, writeFlowYamlText, writeLoopDef, type FlowSpec } from '../helpers/flowFixtures';
import {
  bundledFlowFolders,
  errnoDescription,
  folderPrefixes,
  PASSED,
  passOutcome,
  problemLine,
  problemOutcome,
  usageOutcome,
  USAGE,
  useValidateRuntime,
} from './validateFlowHarness';

const MANUAL_FLOW: FlowSpec = { name: 'hand-flow', steps: [{ id: 'write', kind: 'manual' }] };
const LOOP_NAME = 'repeat-loop';

/** A flow whose loop step repeats back to `backTo`; `backTo: 'review'` names a later step, which the loader rejects. */
const repeatFlow = (backTo: 'draft' | 'review'): FlowSpec => ({
  name: 'repeat-flow',
  steps: [
    { id: 'draft', kind: 'manual' },
    { id: 'build', kind: 'loop', loop: LOOP_NAME, repeat: { backTo, countInput: 'slices' } },
    { id: 'review', kind: 'manual' },
  ],
});

/** The reason the app's own catalog-entry loader gives for the definition at `file`. */
function loaderReason(file: string): string {
  const load = loadUntrustedFlowDefinition(file);
  if (load.ok) throw new Error(`fixture: the loader accepts ${file}`);
  return load.error;
}

/** The app's wording for the catalog resolver's refusal of `id` in `tier`. */
function catalogReason(roots: CatalogRoots, id: string, tier: CatalogTier): string {
  const verdict = resolveCatalogEntry(roots, id, tier);
  if (verdict.ok || verdict.cause === 'unknown') throw new Error(`fixture: the resolver does not refuse ${id} by its location`);
  return catalogRefusalReason(verdict.cause);
}

/** Whether every non-empty line of `reason` appears in `text`, in order. */
function holdsLinesInOrder(text: string, reason: string): boolean {
  let from = 0;
  for (const part of reason.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const at = text.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

test.describe('agent-terminal --validate-flow', { tag: '@ownapp' }, () => {
  const runtime = useValidateRuntime();

  /** A repository with a resolvable `LOOP_NAME` in the operator tier, so a flow that names it stays valid once the
   *  command resolves loops. */
  const repoWithLoop = (name: string): string => {
    writeLoopDef(flowLocations.operatorLoops(runtime.world().configDir), LOOP_NAME);
    return runtime.world().dir(name);
  };

  test('every bundled flow passes', async () => {
    const world = runtime.world();
    for (const folder of bundledFlowFolders(runtime.runtimeMain())) {
      const result = await runtime.validate([folder], { cwd: world.root });
      expect.soft({ folder, ...passOutcome(result) }).toEqual({ folder, ...PASSED });
    }
  });

  test('a flow.yaml whose repeat targets a later step fails with the loader\'s reason, naming that file', async () => {
    const repo = repoWithLoop('repo');
    const file = writeFlow(flowLocations.repoCatalogEntry(repo, 'broken'), repeatFlow('review'));
    const result = await runtime.validate([flowLocations.repoCatalogEntry(repo, 'broken')], { cwd: repo });
    expect(problemOutcome(result, realpathSync(file))).toEqual(problemLine(expect.stringContaining(loaderReason(file))));
  });

  test('the same repository catalog flow with its repeat fixed passes', async () => {
    const repo = repoWithLoop('repo');
    writeFlow(flowLocations.repoCatalogEntry(repo, 'fixed'), repeatFlow('draft'));
    const result = await runtime.validate([flowLocations.repoCatalogEntry(repo, 'fixed')], { cwd: repo });
    expect(passOutcome(result)).toEqual(PASSED);
  });

  test('the same flow with its repeat fixed passes in the local <repo>/.agent-terminal/ form', async () => {
    const repo = repoWithLoop('repo');
    writeFlow(flowLocations.repoLocal(repo), repeatFlow('draft'));
    const result = await runtime.validate([flowLocations.repoLocal(repo)], { cwd: repo });
    expect(passOutcome(result)).toEqual(PASSED);
  });

  test('a rejected local flow.yaml reached through a linked repository is named by its real path', async () => {
    const world = runtime.world();
    const repo = repoWithLoop('repo');
    const file = writeFlow(flowLocations.repoLocal(repo), repeatFlow('review'));
    symlinkSync(repo, join(world.root, 'repo-link'));
    const result = await runtime.validate([flowLocations.repoLocal('repo-link')], { cwd: world.root });
    expect(problemOutcome(result, realpathSync(file))).toEqual(problemLine(expect.stringContaining(loaderReason(file))));
  });

  test('a flow.yaml that is not valid YAML fails on one line carrying the loader\'s multi-line reason', async () => {
    const repo = runtime.world().dir('repo');
    const file = writeFlowYamlText(flowLocations.repoCatalogEntry(repo, 'garbled'), 'name: garbled\nsteps: [\n  { id: a, kind: manual }\n');
    const reason = loaderReason(file);
    if (!reason.includes('\n')) throw new Error(`fixture: the loader's reason is one line: ${reason}`);
    const result = await runtime.validate([flowLocations.repoCatalogEntry(repo, 'garbled')], { cwd: repo });
    const outcome = problemOutcome(result, realpathSync(file));
    expect({ ...outcome, problem: holdsLinesInOrder(outcome.problem, reason) }).toEqual(problemLine(true));
  });

  test('no folder is a usage error', async () => {
    const result = await runtime.validate([], { cwd: runtime.world().root });
    expect(usageOutcome(result)).toEqual(USAGE);
  });

  test('two folders are a usage error', async () => {
    const repo = runtime.world().dir('repo');
    const one = flowLocations.repoCatalogEntry(repo, 'one');
    const two = flowLocations.repoCatalogEntry(repo, 'two');
    writeFlow(one, MANUAL_FLOW);
    writeFlow(two, MANUAL_FLOW);
    const result = await runtime.validate([one, two], { cwd: repo });
    expect(usageOutcome(result)).toEqual(USAGE);
  });

  test.describe('a folder the command cannot use is refused, naming it', () => {
    /** A repository whose catalog folder exists, so each refusal below is about the entry alone. */
    const catalog = (): { repo: string; entry: (id: string) => string } => {
      const repo = runtime.world().dir('repo');
      mkdirSync(flowLocations.repoCatalogEntry(repo, ''), { recursive: true });
      return { repo, entry: (id) => flowLocations.repoCatalogEntry(repo, id) };
    };

    test('a missing folder carries the errno reason', async () => {
      const { repo, entry } = catalog();
      const folder = entry('missing');
      const result = await runtime.validate([folder], { cwd: repo });
      expect(problemOutcome(result, folderPrefixes(repo, folder)))
        .toEqual(problemLine(expect.stringContaining(errnoDescription(() => statSync(folder)))));
    });

    test('a folder that cannot be read (a symbolic-link loop) carries the errno reason', async () => {
      const { repo, entry } = catalog();
      const folder = entry('loop');
      symlinkSync('loop', folder);
      const result = await runtime.validate([folder], { cwd: repo });
      expect(problemOutcome(result, folderPrefixes(repo, folder)))
        .toEqual(problemLine(expect.stringContaining(errnoDescription(() => statSync(folder)))));
    });

    test('a regular file, a missing, an unreadable and a flow.yaml-less folder are refused for four distinct causes', async () => {
      const { repo, entry } = catalog();
      const file = entry('plain');
      writeFileSync(file, 'not a folder\n');
      symlinkSync('loop', entry('loop'));
      mkdirSync(entry('empty'));
      /** The problem text with every spelling of its own folder removed, so two refusals compare by cause alone. */
      const causeOf = (folder: string, problem: string): string =>
        folderPrefixes(repo, folder).reduce((text, spelling) => text.split(spelling).join('<folder>'), problem);
      const problemOf = async (folder: string): Promise<string> =>
        causeOf(folder, problemOutcome(await runtime.validate([folder], { cwd: repo }), folderPrefixes(repo, folder)).problem);
      const others = [await problemOf(entry('missing')), await problemOf(entry('loop')), await problemOf(entry('empty'))];
      const result = await runtime.validate([file], { cwd: repo });
      const outcome = problemOutcome(result, folderPrefixes(repo, file));
      const cause = causeOf(file, outcome.problem);
      expect({ ...outcome, problem: new Set([...others, cause]).size, others }).toEqual({ ...problemLine(others.length + 1), others: expect.any(Array) });
    });

    test('a folder without flow.yaml names flow.yaml', async () => {
      const { repo, entry } = catalog();
      const folder = entry('empty');
      mkdirSync(folder);
      const result = await runtime.validate([folder], { cwd: repo });
      expect(problemOutcome(result, folderPrefixes(repo, folder))).toEqual(problemLine(expect.stringContaining(FLOW_DEF_FILE)));
    });

    test('a flow.yaml that cannot be read (a symbolic-link loop) carries the errno reason', async () => {
      const { repo, entry } = catalog();
      const folder = entry('looped-def');
      mkdirSync(folder);
      const defFile = join(folder, FLOW_DEF_FILE);
      symlinkSync(FLOW_DEF_FILE, defFile);
      const result = await runtime.validate([folder], { cwd: repo });
      expect(problemOutcome(result, folderPrefixes(repo, folder)))
        .toEqual(problemLine(expect.stringContaining(errnoDescription(() => statSync(defFile)))));
    });
  });

  test.describe('a folder outside the tiers, or one the catalog refuses, is refused naming it', () => {
    test('a loadable flow in no tier names the folder and the global tier location', async () => {
      const world = runtime.world();
      const folder = join(world.dir('elsewhere'), 'stray');
      writeFlow(folder, MANUAL_FLOW);
      const result = await runtime.validate([folder], { cwd: world.root });
      expect(problemOutcome(result, folderPrefixes(world.root, folder)))
        .toEqual(problemLine(expect.stringContaining(flowLocations.globalFallback(world.appHome))));
    });

    test('a repository catalog entry whose flow.yaml links outside its tier carries the catalog\'s reason', async () => {
      const world = runtime.world();
      const repo = world.dir('repo');
      const target = writeFlow(world.dir('outside'), MANUAL_FLOW);
      const folder = flowLocations.repoCatalogEntry(repo, 'linked');
      mkdirSync(folder, { recursive: true });
      symlinkSync(target, join(folder, FLOW_DEF_FILE));
      const reason = catalogReason({ worktreeDir: repo, globalRoot: world.appHome }, 'linked', 'repo');
      const result = await runtime.validate([folder], { cwd: repo });
      expect(problemOutcome(result, folderPrefixes(repo, folder))).toEqual(problemLine(expect.stringContaining(reason)));
    });

    test('a repository catalog entry reached through a .agent-terminal that links out of the repository carries the catalog\'s reason', async () => {
      const world = runtime.world();
      const repo = world.dir('repo');
      const elsewhere = world.dir('elsewhere-home');
      writeFlow(join(elsewhere, 'flows', 'away'), MANUAL_FLOW);
      symlinkSync(elsewhere, flowLocations.repoLocal(repo));
      const folder = flowLocations.repoCatalogEntry(repo, 'away');
      const reason = catalogReason({ worktreeDir: repo, globalRoot: world.appHome }, 'away', 'repo');
      const result = await runtime.validate([folder], { cwd: repo });
      expect(problemOutcome(result, folderPrefixes(repo, folder))).toEqual(problemLine(expect.stringContaining(reason)));
    });

    test('a global catalog entry with a valid name passes', async () => {
      const world = runtime.world();
      const folder = flowLocations.globalCatalogEntry(world.appHome, 'hand-flow');
      writeFlow(folder, MANUAL_FLOW);
      const result = await runtime.validate([folder], { cwd: world.root });
      expect(passOutcome(result)).toEqual(PASSED);
    });

    test('a global catalog entry reached through a linked <A>/.agent-terminal passes, as the app reads it', async () => {
      const world = runtime.world();
      symlinkSync(world.dir('dotfiles'), flowLocations.globalFallback(world.appHome));
      const folder = flowLocations.globalCatalogEntry(world.appHome, 'hand-flow');
      writeFlow(folder, MANUAL_FLOW);
      if (!resolveCatalogEntry({ worktreeDir: world.dir('no-repo'), globalRoot: world.appHome }, 'hand-flow', 'global').ok) {
        throw new Error('fixture: the app does not resolve the linked global entry');
      }
      const result = await runtime.validate([folder], { cwd: world.root });
      expect(passOutcome(result)).toEqual(PASSED);
    });

    test('the global fallback <A>/.agent-terminal/ passes', async () => {
      const world = runtime.world();
      const folder = flowLocations.globalFallback(world.appHome);
      writeFlow(folder, MANUAL_FLOW);
      const result = await runtime.validate([folder], { cwd: world.root });
      expect(passOutcome(result)).toEqual(PASSED);
    });

    test('a global catalog entry whose name is not a valid flow id carries the picker\'s reason', async () => {
      const world = runtime.world();
      const id = 'f'.repeat(MAX_CATALOG_ID_LENGTH + 1);
      const folder = flowLocations.globalCatalogEntry(world.appHome, id);
      writeFlow(folder, MANUAL_FLOW);
      const unsafe = listCatalog({ worktreeDir: world.dir('no-repo'), globalRoot: world.appHome }).entries.find((e) => !e.available);
      if (unsafe === undefined || unsafe.available) throw new Error('fixture: the picker lists no unsafe entry');
      const result = await runtime.validate([folder], { cwd: world.root });
      expect(problemOutcome(result, folderPrefixes(world.root, folder))).toEqual(problemLine(expect.stringContaining(unsafe.reason)));
    });

    test('a source tree\'s example flow with a real loops tree passes', async () => {
      const tree = runtime.world().dir('tree');
      writeFlow(flowLocations.bundledEntry(tree, 'sample'), MANUAL_FLOW);
      mkdirSync(flowLocations.bundledLoops(tree), { recursive: true });
      const result = await runtime.validate([flowLocations.bundledEntry(tree, 'sample')], { cwd: tree });
      expect(passOutcome(result)).toEqual(PASSED);
    });

    test('a source tree\'s example flow whose name is not a valid flow id carries the unsafe-name reason', async () => {
      const tree = runtime.world().dir('tree');
      const folder = flowLocations.bundledEntry(tree, 'f'.repeat(MAX_CATALOG_ID_LENGTH + 1));
      writeFlow(folder, MANUAL_FLOW);
      mkdirSync(flowLocations.bundledLoops(tree), { recursive: true });
      const result = await runtime.validate([folder], { cwd: tree });
      expect(problemOutcome(result, folderPrefixes(tree, folder))).toEqual(problemLine(expect.stringContaining(UNSAFE_NAME_REASON)));
    });

    test('a source tree\'s example flow whose loops tree links out of the tree is refused', async () => {
      const world = runtime.world();
      const tree = world.dir('tree');
      const folder = flowLocations.bundledEntry(tree, 'sample');
      writeFlow(folder, MANUAL_FLOW);
      symlinkSync(world.dir('outside-loops'), flowLocations.bundledLoops(tree));
      const result = await runtime.validate([folder], { cwd: tree });
      expect(problemOutcome(result, folderPrefixes(tree, folder))).toEqual(problemLine());
    });

    test('a source tree\'s example flow whose flow.yaml links out of the tree is refused', async () => {
      const world = runtime.world();
      const tree = world.dir('tree');
      const folder = flowLocations.bundledEntry(tree, 'sample');
      mkdirSync(folder, { recursive: true });
      mkdirSync(flowLocations.bundledLoops(tree), { recursive: true });
      symlinkSync(writeFlow(world.dir('outside'), MANUAL_FLOW), join(folder, FLOW_DEF_FILE));
      const result = await runtime.validate([folder], { cwd: tree });
      expect(problemOutcome(result, folderPrefixes(tree, folder))).toEqual(problemLine());
    });
  });

  test('a relative folder resolves against the caller\'s working directory', async () => {
    const world = runtime.world();
    const good = repoWithLoop('good');
    const bad = world.dir('bad');
    const relative = join('.agent-terminal', 'flows', 'f');
    writeFlow(join(good, relative), repeatFlow('draft'));
    const badFile = writeFlow(join(bad, relative), repeatFlow('review'));
    const fromGood = await runtime.validate([relative], { cwd: good });
    expect.soft(passOutcome(fromGood)).toEqual(PASSED);
    const fromBad = await runtime.validate([relative], { cwd: bad });
    expect.soft(problemOutcome(fromBad, realpathSync(badFile))).toEqual(problemLine(expect.stringContaining(loaderReason(badFile))));
  });

  test('a removed working directory still validates an absolute folder, and refuses a relative one on one line', async () => {
    const world = runtime.world();
    const folder = flowLocations.repoCatalogEntry(world.dir('repo'), 'f');
    writeFlow(folder, MANUAL_FLOW);
    const absolute = await runtime.validateFromRemovedCwd([folder], { cwd: world.dir('gone-one') });
    expect.soft(passOutcome(absolute)).toEqual(PASSED);
    const relative = await runtime.validateFromRemovedCwd(['f'], { cwd: world.dir('gone-two') });
    expect.soft(problemOutcome(relative, 'f')).toEqual(problemLine());
  });

  test('a line break in the folder\'s path still gives one line, on a pass and on a refusal', async () => {
    const world = runtime.world();
    const passing = flowLocations.repoCatalogEntry(world.dir('repo\nOK: forged'), 'f');
    writeFlow(passing, MANUAL_FLOW);
    const pass = await runtime.validate([passing], { cwd: world.root });
    expect.soft(passOutcome(pass)).toEqual(PASSED);
    const stray = join(world.dir('elsewhere\nOK: forged'), 'stray');
    writeFlow(stray, MANUAL_FLOW);
    const { status, oneLine } = problemOutcome(await runtime.validate([stray], { cwd: world.root }), stray);
    expect.soft({ status, oneLine }).toEqual({ status: 1, oneLine: true });
  });

  test('a repository path with spaces and shell metacharacters validates as one operand and runs nothing', async () => {
    const world = runtime.world();
    const name = 'my repo; $(touch pwned) \'q" `touch ticked`';
    const repo = world.dir(name);
    writeFlow(flowLocations.repoCatalogEntry(repo, 'f'), MANUAL_FLOW);
    const result = await runtime.validate([flowLocations.repoCatalogEntry(name, 'f')], { cwd: world.root });
    const planted = ['pwned', 'ticked'].filter((f) => existsSync(join(world.root, f)) || existsSync(join(repo, f)));
    expect({ ...passOutcome(result), planted }).toEqual({ ...PASSED, planted: [] });
  });
});
