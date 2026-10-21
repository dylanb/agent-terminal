import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createBenchFixtureBuilder, type BenchFixtureBuilder } from '../helpers/benchFixtureBuilder';
import { createBenchRoots, type BenchRoots } from '../helpers/benchRoots';
import { createFakeBenchGithub } from '../helpers/benchFakeGithub';
import { createFakeLauncher } from '../helpers/benchFakeLauncher';
import { FIXTURE_ARTIFACTS, FIXTURE_INPUTS, runRequest, V3_FLOW } from '../helpers/benchRunSetup';
import { writeLoopCapabilities } from '../helpers/loopCapabilities';
import { binding, createAppLoopEngineHarness, ROSTER, STEP, type AppLoopEngineHarness } from '../helpers/appLoopEngineHarness';
import { captureFixture } from '../../src/main/benchCapture';
import { runBench } from '../../src/main/benchRun';
import { createFlowStateStore } from '../../src/main/flowState';
import { readChangedTests, recordBaselineCommit } from '../../src/main/appLoopState';
import { createLoopCompletionPredicates, type LoopCompletionPredicates } from '../../src/main/loopCompletionPredicates';
import { currentGitBranch } from '../../src/main/gitBranch';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from '../../src/main/appLoopPaths';
import { examplePhaseResult } from '../../src/shared/phaseResult';
import { GREEN_COMPLETING_OUTCOME } from '../../src/shared/phaseOutcome';
import { GREEN_COMPLETING_BUILD_OUTCOME } from '../../src/shared/buildOutcome';

// #180 AC 11 — a fixture captured right after RED was approved carries RED's phase baseline, so a GREEN work turn
// in a run prepared from it meets the frozen-tests check (§28.5.1) with that baseline on the run's own branch.

let b: BenchFixtureBuilder;
let roots: BenchRoots;
let h: AppLoopEngineHarness | undefined;
afterEach(() => {
  h?.tearDown();
  h = undefined;
  b?.cleanup();
  roots?.cleanup();
});

const TEST_FILE = 'tests/a.test.ts';

interface RedApprovedRepo {
  repo: string;
  /** The commit RED's approve made, with the test file as RED wrote it. */
  red: string;
  /** A later commit that changes the test file: the fixture's commit. */
  head: string;
}

function redApprovedRepo(): RedApprovedRepo {
  const { dir } = b.makeRepository('bench-baseline');
  writeLoopCapabilities(dir, { testGlobs: ['tests/**'] });
  b.writeRepoFile(dir, TEST_FILE, "it('fails', () => expect(1).toBe(2));\n");
  const red = b.commitAll(dir, 'RED');
  b.writeRepoFile(dir, TEST_FILE, "it('fails', () => expect(1).toBe(3));\n");
  const head = b.commitAll(dir, 'after RED');
  b.seedFlow(dir, 'feature-dev-v3', V3_FLOW);
  createFlowStateStore(dir).write({ step: 'green', status: 'not_started', inputs: { ticket: '180', ...FIXTURE_INPUTS } });
  b.writeArtifacts(dir, FIXTURE_ARTIFACTS);
  return { repo: dir, red, head };
}

/** Drives one GREEN work turn through the real engine in `workingFolder` past its done-signal, with the production
 *  baseline reader, branch reader and frozen-tests check: whether its review round started, and the changed-test
 *  flag its completion recorded. */
async function greenTurn(workingFolder: string): Promise<{ reviewStarted: boolean; changedTests: unknown }> {
  h = createAppLoopEngineHarness();
  h.setUp();
  rmSync(h.repo, { recursive: true, force: true });
  h.repo = workingFolder;
  const artifacts = join(workingFolder, ...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR);
  mkdirSync(artifacts, { recursive: true });
  h.resultPath = join(artifacts, 'green-result.json');
  h.defResult = h.resolved({
    ...h.fileDef(),
    work: { recipe: join(workingFolder, 'recipe', 'work.md'), artifact: 'green-result', completion: 'green' },
    outputs: [binding('green-result', h.resultPath)],
  });
  const real = createLoopCompletionPredicates();
  // The frozen-tests check runs git; the turn settles only once it has answered.
  let frozenCheck: Promise<unknown> = Promise.resolve();
  const predicates: LoopCompletionPredicates = { ...real, changedTestPaths: (query) => (frozenCheck = real.changedTestPaths(query)) as ReturnType<LoopCompletionPredicates['changedTestPaths']> };
  const engine = h.makeEngine(undefined, predicates, null, { currentBranch: currentGitBranch });
  h.enterAndInjectWork(engine);
  h.writeResult(examplePhaseResult(GREEN_COMPLETING_OUTCOME, { build: GREEN_COMPLETING_BUILD_OUTCOME }));
  engine.onDoneSignal();
  await frozenCheck;
  await new Promise((r) => setTimeout(r, 0));
  engine.onInjectable();
  engine.onInjectable();
  return { reviewStarted: h.injected.some((prompt) => prompt.includes(ROSTER[0])), changedTests: readChangedTests(workingFolder) };
}

describe('a GREEN turn in a run prepared from a fixture captured after RED', () => {
  it.each([
    { baseline: 'red' as const, changed: [TEST_FILE] },
    { baseline: 'head' as const, changed: [] },
  ])("completes, not blocked for a missing RED baseline, and records the test files changed since the fixture's baseline (the $baseline commit)", async ({ baseline, changed }) => {
    b = createBenchFixtureBuilder();
    roots = createBenchRoots();
    const r = redApprovedRepo();
    recordBaselineCommit(r.repo, 'main', r[baseline]);
    const fixture = join(b.outsideDir('bench-baseline-fx'), 'fx');
    const captured = await captureFixture({ workingFolder: r.repo, fixtureDir: fixture, appHome: roots.appHome, github: createFakeBenchGithub() });
    if (!captured.ok) throw new Error(`setup: capture refused (${captured.code})`);
    const launcher = createFakeLauncher();
    await runBench(runRequest({ repo: r.repo, fixture }, roots, { span: { first: 'green', last: 'green' } }, { launcher }));
    const workingFolder = launcher.launches[0]?.workingFolder;
    if (workingFolder === undefined) throw new Error('setup: the run was not launched');

    const turn = await greenTurn(workingFolder);

    expect(turn).toEqual({ reviewStarted: true, changedTests: { step: STEP, paths: changed } });
  });
});
