// `agent-terminal --validate-flow <dir>` on a flow whose loops, loop references, todo templates or engine
// bindings are broken, and one case per tier of where a flow's loops resolve, run through the installed runtime so
// the app's own home and loop tiers reach the check.
// Every test asserts only what the command prints, its exit status and, for the writes-nothing case, the state of
// the files around the run.

import { expect, test } from '@playwright/test';
import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { resolveLoopDefV2, type LoopDefV2Context } from '../../src/main/loopDefV2';
import { loadTodoTemplateFile, todoTemplateFile, todoTemplatesDir } from '../../src/main/todoTemplate';
import { userConfigLoopsDir } from '../../src/main/userConfig';
import { EXEC_SIDE_EFFECT_KIND, REQUEST_CHANGES_OPTION } from '../../src/shared/engineCapabilities/loop';
import { MARKED_BINDING_REASON, RETIRED_LOOP_NAMESPACE } from '../../src/shared/loopNamespace';
import { fixtureResolves, flowLocations, writeFifo, writeFlow, writeLoopDef, writeLoopRegistry, type FlowSpec, type FlowStepSpec, type LoopDefSpec } from '../helpers/flowFixtures';
import { snapshotTree } from '../helpers/treeSnapshot';
import { PASSED, passOutcome, problemLine, problemOutcome, useValidateRuntime, type RunResult } from './validateFlowHarness';

/** A flow with one loop step per name, in order. */
const loopFlow = (name: string, loops: readonly string[], extra: readonly FlowStepSpec[] = []): FlowSpec => ({
  name,
  steps: [...loops.map((loop, i): FlowStepSpec => ({ id: `step-${i + 1}`, kind: 'loop', loop })), ...extra],
});

/** The expected outcome of a run whose one problem names `item`. */
const naming = (item: string): ReturnType<typeof problemLine> => problemLine(expect.stringContaining(item));

test.describe('agent-terminal --validate-flow checks loops, references, templates and bindings', { tag: '@ownapp' }, () => {
  const runtime = useValidateRuntime();

  const operatorLoops = (): string => flowLocations.operatorLoops(runtime.world().configDir);

  /** The loop tiers the app hands a run, for a repository flow in `repo`. */
  const appContext = (repo: string, flow: string): LoopDefV2Context => ({
    tiers: {
      operator: operatorLoops(),
      appBundled: flowLocations.bundledLoops(runtime.runtimeMain()),
      retired: userConfigLoopsDir(runtime.world().configDir),
    },
    repoDir: repo,
    flow,
  });

  const validateIn = (folder: string, cwd: string): Promise<RunResult> => runtime.validate([folder], { cwd });

  test.describe('each defect fails on one line naming its file', () => {
    test('a loop that no tier holds is a flow.yaml problem naming the loop', async () => {
      const repo = runtime.world().dir('repo');
      const folder = flowLocations.repoCatalogEntry(repo, 'f');
      const flowFile = writeFlow(folder, loopFlow('f', ['missing-loop']));
      fixtureResolves('missing-loop', appContext(repo, 'f'), false);
      const result = await validateIn(folder, repo);
      expect(problemOutcome(result, realpathSync(flowFile))).toEqual(naming('missing-loop'));
    });

    const rejected: readonly { what: string; spec: LoopDefSpec }[] = [
      { what: 'a request-changes gate option in a loop with no review rounds', spec: { gate: [{ option: REQUEST_CHANGES_OPTION }] } },
      { what: 'a gate side-effect of the exec kind', spec: { gate: [{ option: 'approve', side_effects: [{ kind: EXEC_SIDE_EFFECT_KIND, program: 'true' }] }] } },
      { what: 'a work recipe reference that escapes the tier root', spec: { recipe: '../../escaped-recipe.md' } },
    ];
    for (const { what, spec } of rejected) {
      test(`a loop definition with ${what} fails with the loop loader's reason, naming that definition`, async () => {
        const repo = runtime.world().dir('repo');
        const defFile = writeLoopDef(operatorLoops(), 'rejected-loop', spec);
        const folder = flowLocations.repoCatalogEntry(repo, 'f');
        writeFlow(folder, loopFlow('f', ['rejected-loop']));
        const verdict = resolveLoopDefV2('rejected-loop', appContext(repo, 'f'));
        if (verdict.ok) throw new Error(`fixture: the loop loader accepts ${what}`);
        const result = await validateIn(folder, repo);
        expect(problemOutcome(result, realpathSync(defFile))).toEqual(naming(verdict.reason));
      });
    }

    const unreadable: readonly { what: string; ref: string; spec: LoopDefSpec; pipe?: true }[] = [
      { what: 'a missing brief', ref: 'missing-brief.md', spec: { brief: 'missing-brief.md', absent: ['missing-brief.md'] } },
      { what: 'a missing work recipe', ref: 'missing-recipe.md', spec: { recipe: 'missing-recipe.md', absent: ['missing-recipe.md'] } },
      { what: 'a work recipe that is a directory', ref: 'recipe-folder', spec: { recipe: 'recipe-folder', directories: ['recipe-folder'] } },
      { what: 'a work recipe that is a named pipe', ref: 'pipe-recipe.md', spec: { recipe: 'pipe-recipe.md', absent: ['pipe-recipe.md'] }, pipe: true },
      {
        what: 'a missing consolidator recipe',
        ref: 'missing-consolidator.md',
        spec: { consolidator: 'missing-consolidator.md', charters: ['charter.md'], absent: ['missing-consolidator.md'] },
      },
      {
        what: 'a missing reviewer charter',
        ref: 'charters/missing-charter.md',
        spec: { consolidator: 'consolidate.md', charters: ['charters/missing-charter.md'], absent: ['charters/missing-charter.md'] },
      },
    ];
    for (const { what, ref, spec, pipe } of unreadable) {
      test(`a loop definition whose references all resolve passes, and one with ${what} fails naming that reference and that definition`, async () => {
        const repo = runtime.world().dir('repo');
        const folder = flowLocations.repoCatalogEntry(repo, 'f');
        writeLoopDef(operatorLoops(), 'whole-loop', { brief: 'brief.md', recipe: 'work/recipe.md', consolidator: 'consolidate.md', charters: ['charters/a.md', 'charters/b.md'] });
        writeFlow(folder, loopFlow('f', ['whole-loop']));
        fixtureResolves('whole-loop', appContext(repo, 'f'), true);
        expect.soft(passOutcome(await validateIn(folder, repo))).toEqual(PASSED);
        const defFile = writeLoopDef(operatorLoops(), 'holey-loop', spec);
        if (pipe) writeFifo(join(dirname(defFile), ref));
        writeFlow(folder, loopFlow('f', ['holey-loop']));
        fixtureResolves('holey-loop', appContext(repo, 'f'), true);
        const result = await validateIn(folder, repo);
        expect(problemOutcome(result, realpathSync(defFile))).toEqual(naming(ref));
      });
    }

    test('a todo template that resolves passes with and without .md, and a missing one fails naming it', async () => {
      const repo = runtime.world().dir('repo');
      const folder = flowLocations.repoCatalogEntry(repo, 'f');
      const resolving: FlowStepSpec[] = [
        { id: 'with-ext', kind: 'manual', todoTemplate: 'with-ext.md' },
        { id: 'without-ext', kind: 'manual', todoTemplate: 'without-ext' },
      ];
      writeFlow(folder, { name: 'f', steps: resolving, templates: ['with-ext.md', 'without-ext'] });
      expect.soft(passOutcome(await validateIn(folder, repo))).toEqual(PASSED);
      const flowFile = writeFlow(folder, { name: 'f', steps: [...resolving, { id: 'gap', kind: 'manual', todoTemplate: 'absent-template' }] });
      expect.soft(problemOutcome(await validateIn(folder, repo), realpathSync(flowFile))).toEqual(naming('absent-template'));
    });

    test('a loop step\'s todo template reference that leaves todo-templates/ fails naming it, though the file it names exists', async () => {
      const repo = runtime.world().dir('repo');
      writeLoopDef(operatorLoops(), 'operator-loop');
      const folder = flowLocations.repoCatalogEntry(repo, 'f');
      const flowFile = writeFlow(folder, { name: 'f', steps: [{ id: 'escape', kind: 'loop', loop: 'operator-loop', todoTemplate: '../outside' }] });
      writeFileSync(join(folder, todoTemplateFile('outside')), '- a todo outside the templates folder\n');
      if (loadTodoTemplateFile(todoTemplatesDir(folder), '../outside') !== null) throw new Error('fixture: a run resolves the escaping template');
      const result = await validateIn(folder, repo);
      expect(problemOutcome(result, realpathSync(flowFile))).toEqual(naming('../outside'));
    });

    test('a loop step bound to the retired engine fails naming the step, with the app\'s marked-binding reason', async () => {
      const repo = runtime.world().dir('repo');
      const folder = flowLocations.repoCatalogEntry(repo, 'f');
      const flowFile = writeFlow(folder, {
        name: 'f',
        steps: [{ id: 'old-step', kind: 'loop', loop: 'gone-engine-loop', namespace: RETIRED_LOOP_NAMESPACE }],
      });
      fixtureResolves('gone-engine-loop', appContext(repo, 'f'), false);
      const outcome = problemOutcome(await validateIn(folder, repo), realpathSync(flowFile));
      const facts = { namesStep: outcome.problem.includes('old-step'), carriesReason: outcome.problem.includes(MARKED_BINDING_REASON) };
      expect({ ...outcome, problem: facts }).toEqual(problemLine({ namesStep: true, carriesReason: true }));
    });
  });

  test.describe('a count_from repeat whose artifact no step\'s loop outputs', () => {
    const REPEAT_STEP = 'repeat-here';
    const repeatFlow = (repo: string, artifact: string): { folder: string; flowFile: string } => {
      writeLoopDef(operatorLoops(), 'design-loop', { outputs: { steps: 'steps.json' }, artifact: 'steps' });
      writeLoopDef(operatorLoops(), 'work-loop');
      const folder = flowLocations.repoCatalogEntry(repo, 'f');
      const flowFile = writeFlow(folder, {
        name: 'f',
        steps: [
          { id: 'design', kind: 'loop', loop: 'design-loop' },
          { id: 'build', kind: 'loop', loop: 'work-loop' },
          { id: REPEAT_STEP, kind: 'loop', loop: 'work-loop', repeat: { backTo: 'build', countFrom: { artifact, format: 'json-list', list: 'steps' } } },
        ],
      });
      return { folder, flowFile };
    };

    test('fails on one flow.yaml line naming the repeat step and the artifact', async () => {
      const repo = runtime.world().dir('repo');
      const { folder, flowFile } = repeatFlow(repo, 'nowhere');
      const outcome = problemOutcome(await validateIn(folder, repo), realpathSync(flowFile));
      const facts = { namesStep: outcome.problem.includes(REPEAT_STEP), namesArtifact: outcome.problem.includes('nowhere') };
      expect({ ...outcome, problem: facts }).toEqual(problemLine({ namesStep: true, namesArtifact: true }));
    });

    test('passes once a step\'s loop outputs the artifact', async () => {
      const repo = runtime.world().dir('repo');
      expect(passOutcome(await validateIn(repeatFlow(repo, 'steps').folder, repo))).toEqual(PASSED);
    });
  });

  test.describe('a flow\'s loops resolve in the tier its folder sits in', () => {
    /** Runs `folder` once naming only `positive`, then again naming `positive` and `mustFail`, from each of `cwds`.
     *  The first run must pass and the second must print exactly `mustFail`'s flow.yaml line. */
    const passesThenNamesOnly = async (
      folder: string,
      positive: readonly string[],
      mustFail: string,
      cwds: readonly string[],
      flowName = 'f',
    ): Promise<void> => {
      for (const cwd of cwds) {
        writeFlow(folder, loopFlow(flowName, positive));
        expect.soft({ cwd, ...passOutcome(await validateIn(folder, cwd)) }).toEqual({ cwd, ...PASSED });
        const flowFile = writeFlow(folder, loopFlow(flowName, [...positive, mustFail]));
        expect.soft({ cwd, ...problemOutcome(await validateIn(folder, cwd), realpathSync(flowFile)) }).toEqual({ cwd, ...naming(mustFail) });
      }
    };

    /** A loop that only `repo`'s own `.agent-loop.yaml` resolves. */
    const overrideLoop = (repo: string, name: string): void => {
      const defFile = writeLoopDef(join(repo, 'own-loops'), name);
      writeLoopRegistry(repo, { [name]: relative(repo, defFile) });
    };

    test('a repository catalog flow resolves a loop through the repository\'s override registry', async () => {
      const repo = runtime.world().dir('repo');
      overrideLoop(repo, 'override-loop');
      fixtureResolves('override-loop', appContext(repo, 'f'), true);
      fixtureResolves('override-loop', appContext(runtime.world().dir('other'), 'f'), false);
      await passesThenNamesOnly(flowLocations.repoCatalogEntry(repo, 'f'), ['override-loop'], 'nowhere-loop', [repo, runtime.world().dir('elsewhere')]);
    });

    /** A is itself a repository whose override maps `overridden`, and so is a second working directory; the
     *  operator tier holds `operator-loop`. */
    const globalWorld = (): { cwds: string[] } => {
      const world = runtime.world();
      overrideLoop(world.appHome, 'overridden-loop');
      const cwdRepo = world.dir('cwd-repo');
      overrideLoop(cwdRepo, 'overridden-loop');
      writeLoopDef(operatorLoops(), 'operator-loop');
      fixtureResolves('overridden-loop', appContext(world.appHome, 'f'), true);
      fixtureResolves('overridden-loop', appContext(cwdRepo, 'f'), true);
      return { cwds: [world.root, cwdRepo] };
    };

    test('a global catalog flow consults no repository override, from any working directory', async () => {
      const { cwds } = globalWorld();
      await passesThenNamesOnly(flowLocations.globalCatalogEntry(runtime.world().appHome, 'f'), ['operator-loop'], 'overridden-loop', cwds);
    });

    /** Writes `name` into the installed copy's bundled loop tree, which this worker's tests share, and removes it
     *  after the test. */
    const shippedLoop = (name: string): void => {
      const defFile = writeLoopDef(flowLocations.bundledLoops(runtime.runtimeMain()), name);
      runtime.onTeardown(async () => { rmSync(dirname(defFile), { recursive: true, force: true }); });
      const app = appContext(runtime.world().dir('other'), 'f');
      fixtureResolves(name, app, true);
      fixtureResolves(name, { ...app, tiers: { ...app.tiers, appBundled: runtime.world().dir('empty-bundle') } }, false);
    };

    test('a repository catalog flow resolves a loop held only in the app\'s bundled loop tree', async () => {
      const repo = runtime.world().dir('repo');
      shippedLoop('shipped-loop');
      await passesThenNamesOnly(flowLocations.repoCatalogEntry(repo, 'f'), ['shipped-loop'], 'nowhere-loop', [repo]);
    });

    test('one of the app\'s own bundled flows resolves loops in the app\'s bundled loop tree and not in the operator tier', async () => {
      const world = runtime.world();
      shippedLoop('shipped-loop');
      writeLoopDef(operatorLoops(), 'operator-only-loop');
      fixtureResolves('operator-only-loop', appContext(world.dir('other'), 'f'), true);
      const folder = flowLocations.bundledEntry(runtime.runtimeMain(), 'probe-flow');
      runtime.onTeardown(async () => { rmSync(folder, { recursive: true, force: true }); });
      await passesThenNamesOnly(folder, ['shipped-loop'], 'operator-only-loop', [world.root]);
    });
  });

  test('the command writes nothing, on a pass or on a failure', async () => {
    const world = runtime.world();
    const repo = world.dir('repo');
    writeLoopDef(operatorLoops(), 'operator-loop');
    const folder = flowLocations.repoCatalogEntry(repo, 'f');
    const read = [world.root, flowLocations.bundledLoops(runtime.runtimeMain())];
    const snapshot = (): unknown => read.map(snapshotTree);

    writeFlow(folder, loopFlow('f', ['operator-loop']));
    const beforePass = snapshot();
    expect.soft((await validateIn(folder, repo)).status).toBe(0);
    expect.soft(snapshot()).toEqual(beforePass);

    writeFlow(folder, loopFlow('f', ['operator-loop', 'nowhere-loop']));
    const beforeFail = snapshot();
    expect.soft((await validateIn(folder, repo)).status).toBe(1);
    expect.soft(snapshot()).toEqual(beforeFail);
  });
});
