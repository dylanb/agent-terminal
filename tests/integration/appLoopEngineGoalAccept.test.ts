import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { goalProgressRel, goalRefactorResultFile, readAppLoopState, recordBaselineCommit, writeAppLoopState, type AppLoopRunState } from '../../src/main/appLoopState';
import type { LoopCompletionPredicates } from '../../src/main/loopCompletionPredicates';
import type { LoopDefV2 } from '../../src/main/loopDefV2';
import { exampleGoalProgress } from '../../src/shared/goalProgress';
import { GREEN_COMPLETING_BUILD_OUTCOME } from '../../src/shared/buildOutcome';
import { GREEN_COMPLETING_OUTCOME, REFACTOR_COMPLETING_OUTCOME, RED_COMPLETING_OUTCOME } from '../../src/shared/phaseOutcome';
import { examplePhaseResult } from '../../src/shared/phaseResult';
import { binding, createAppLoopEngineHarness, STEP, TEST_BRANCH, TURN_KEY } from '../helpers/appLoopEngineHarness';
import { makeFakeCompletionPredicates } from '../helpers/fakeCompletionPredicates';

// §27.3/§27.12c (v2.201) — an Accept that waits on a phase's machine check reads the goal progress again once the
// check returns, and acts on what it then records, as an Accept that did not wait would.

const h = createAppLoopEngineHarness();
const { resolved, makeEngine, fileDef, enterAndInjectWork } = h;

const GOAL = 'every reviewer found nothing to fix';
const BLOCKED = 'Leg: 1\nStatus: blocked\n\n## Blocked\nModal or page?\n';
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const writeAt = (abs: string, text: string): void => {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
};
const session = (): string => {
  const s = readAppLoopState(h.repo)?.goalSession;
  if (s === undefined) throw new Error('no goal session is persisted');
  return s;
};
const writeProgress = (text: string): void => writeAt(join(h.repo, goalProgressRel(session())), text);

interface Phase {
  name: string;
  def: () => LoopDefV2;
  /** The fake whose awaited check rewrites the progress mid-check. */
  predicates: (rewrite: () => void) => Partial<LoopCompletionPredicates>;
  writeResult: () => void;
}

const goal = (def: LoopDefV2): LoopDefV2 => ({ ...def, work: { ...def.work, goal: GOAL, checkpoint: { passes: 3 } }, rounds: { kind: 'none' } });

const PHASES: Phase[] = [
  {
    name: 'RED',
    def: () => goal(h.redDef()),
    predicates: (rewrite) => ({
      workingTreeTestPaths: async () => {
        rewrite();
        return { ok: true, paths: ['tests/a.test.ts'] };
      },
    }),
    writeResult: () => h.writeResult(examplePhaseResult(RED_COMPLETING_OUTCOME)),
  },
  {
    name: 'GREEN',
    def: () =>
      goal({
        ...fileDef(),
        work: { recipe: join(h.repo, 'recipe', 'work.md'), artifact: 'green-result', completion: 'green' },
        outputs: [binding('green-result', h.resultPath)],
      }),
    predicates: (rewrite) => ({
      changedTestPaths: async () => {
        rewrite();
        return { ok: true, paths: [] };
      },
    }),
    writeResult: () => h.writeResult(examplePhaseResult(GREEN_COMPLETING_OUTCOME, { build: GREEN_COMPLETING_BUILD_OUTCOME })),
  },
  {
    name: 'refactor',
    def: () => goal(h.refactorDef()),
    predicates: (rewrite) => ({
      changedTestPaths: async () => {
        rewrite();
        return { ok: true, paths: [] };
      },
    }),
    writeResult: () => writeAt(goalRefactorResultFile(h.repo, session())!, examplePhaseResult(REFACTOR_COMPLETING_OUTCOME)),
  },
];

beforeEach(h.setUp);
afterEach(h.tearDown);

describe('an Accept reads the goal progress again after its machine check (§27.3/§27.12c v2.201)', () => {
  it.each(PHASES)('$name: a session that turned blocked while the check ran reaches the gate as stop for a human', async (phase) => {
    const engine = makeEngine(undefined, makeFakeCompletionPredicates(phase.predicates(() => writeProgress(BLOCKED))));
    recordBaselineCommit(h.repo, TEST_BRANCH, 'a'.repeat(40));
    h.defResult = resolved(phase.def());
    enterAndInjectWork(engine);
    engine.onStall();
    writeProgress(exampleGoalProgress(1, 'done'));
    phase.writeResult();
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    await flush();

    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', verdict: 'stop for a human', verdictReason: 'Modal or page?' });
  });

  it.each(PHASES)('$name: a session that checkpointed while the check ran starts its next leg', async (phase) => {
    const engine = makeEngine(undefined, makeFakeCompletionPredicates(phase.predicates(() => writeProgress(exampleGoalProgress(1, 'checkpoint')))));
    recordBaselineCommit(h.repo, TEST_BRANCH, 'a'.repeat(40));
    h.defResult = resolved(phase.def());
    enterAndInjectWork(engine);
    engine.onStall();
    writeProgress(exampleGoalProgress(1, 'done'));
    phase.writeResult();
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    await flush();
    engine.onInjectable();
    engine.onInjectable();

    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'working', leg: 2 });
    expect(engine.liveErrorFor(h.repo)).toBeNull();
    expect(h.injected.some((p) => p.startsWith('/compact '))).toBe(true);
  });

  it.each(PHASES)('$name: a session whose progress went missing while the check ran is refused with the reason', async (phase) => {
    const engine = makeEngine(undefined, makeFakeCompletionPredicates(phase.predicates(() => rmSync(join(h.repo, goalProgressRel(session()))))));
    recordBaselineCommit(h.repo, TEST_BRANCH, 'a'.repeat(40));
    h.defResult = resolved(phase.def());
    enterAndInjectWork(engine);
    engine.onStall();
    writeProgress(exampleGoalProgress(1, 'done'));
    phase.writeResult();
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    await flush();

    expect(readAppLoopState(h.repo)?.status).not.toBe('complete');
    expect(engine.liveErrorFor(h.repo)?.reason).toMatch(/goal progress file \S+ is missing/);
  });

  it.each(PHASES)('$name: a session the done-signal already sent to the gate while the check ran is not sent again', async (phase) => {
    const engine = makeEngine(
      undefined,
      makeFakeCompletionPredicates(
        phase.predicates(() => {
          writeProgress(BLOCKED);
          engine.onDoneSignal();
        }),
      ),
    );
    recordBaselineCommit(h.repo, TEST_BRANCH, 'a'.repeat(40));
    h.defResult = resolved(phase.def());
    enterAndInjectWork(engine);
    engine.onStall();
    writeProgress(exampleGoalProgress(1, 'done'));
    phase.writeResult();
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    await flush();
    await flush();

    const blocks = h.audit.mock.calls.map((c) => String(c[1])).filter((l) => l.includes('blocked on the operator'));
    expect(blocks).toHaveLength(1);
  });

  it.each(PHASES)('$name: a second Accept while the first waits on its check does not act twice', async (phase) => {
    const engine = makeEngine(undefined, makeFakeCompletionPredicates(phase.predicates(() => writeProgress(BLOCKED))));
    recordBaselineCommit(h.repo, TEST_BRANCH, 'a'.repeat(40));
    h.defResult = resolved(phase.def());
    enterAndInjectWork(engine);
    engine.onStall();
    writeProgress(exampleGoalProgress(1, 'done'));
    phase.writeResult();
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    await flush();

    const blocks = h.audit.mock.calls.map((c) => String(c[1])).filter((l) => l.includes('blocked on the operator'));
    expect(blocks).toHaveLength(1);
  });

  it.each(PHASES)('$name: a finished session whose gate could not be saved is accepted once the save works', async (phase) => {
    let failNextComplete = true;
    const persist = (repoDir: string, state: AppLoopRunState): void => {
      if (state.status === 'complete' && failNextComplete) {
        failNextComplete = false;
        throw new Error('ENOSPC: no space left on device');
      }
      writeAppLoopState(repoDir, state);
    };
    const engine = makeEngine(persist, makeFakeCompletionPredicates(phase.predicates(() => {})));
    recordBaselineCommit(h.repo, TEST_BRANCH, 'a'.repeat(40));
    h.defResult = resolved(phase.def());
    enterAndInjectWork(engine);
    writeProgress(exampleGoalProgress(1, 'done'));
    phase.writeResult();
    engine.onDoneSignal();
    await flush();
    expect(engine.liveErrorFor(h.repo)?.reason).toMatch(/could not be saved/);
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    await flush();

    expect(readAppLoopState(h.repo)?.status).toBe('complete');
  });

  it('an Accept on a turn Retry has since replaced does not lift the guard on the new turn\'s Accept', async () => {
    const phase = PHASES[2];
    const waits: (() => void)[] = [];
    const engine = makeEngine(
      undefined,
      makeFakeCompletionPredicates({
        changedTestPaths: () =>
          new Promise((r) => {
            writeProgress(BLOCKED);
            waits.push(() => r({ ok: true, paths: [] }));
          }),
      }),
    );
    recordBaselineCommit(h.repo, TEST_BRANCH, 'a'.repeat(40));
    h.defResult = resolved(phase.def());
    enterAndInjectWork(engine);
    engine.onStall();
    writeProgress(exampleGoalProgress(1, 'done'));
    phase.writeResult();
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    engine.onStall();
    writeProgress(exampleGoalProgress(1, 'done'));
    phase.writeResult();
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    waits[0]();
    await flush();
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    for (const w of waits.slice(1)) w();
    await flush();

    const blocks = h.audit.mock.calls.map((c) => String(c[1])).filter((l) => l.includes('blocked on the operator'));
    expect(blocks).toHaveLength(1);
  });

  it('an Accept does not finish a turn its own done-signal resumed and failed again while the check ran', async () => {
    const phase = PHASES[2];
    let call = 0;
    let releaseAccept!: () => void;
    const engine = makeEngine(
      undefined,
      makeFakeCompletionPredicates({
        recoverExitCode: () => {
          call += 1;
          if (call === 2) return new Promise((r) => (releaseAccept = () => r(null)));
          return Promise.resolve(call === 1 ? null : 1);
        },
      }),
    );
    recordBaselineCommit(h.repo, TEST_BRANCH, 'a'.repeat(40));
    h.defResult = resolved(phase.def());
    enterAndInjectWork(engine);
    engine.onDoneSignal();
    await flush();
    engine.onInjectable();
    engine.onStall();
    writeProgress(exampleGoalProgress(1, 'done'));
    phase.writeResult();
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    engine.onDoneSignal();
    await flush();
    releaseAccept();
    await flush();

    expect(readAppLoopState(h.repo)?.status).toBe('error');
    expect(h.audit.mock.calls.map((c) => String(c[1])).some((l) => l.includes('accepted'))).toBe(false);
  });

  it.each(PHASES)('$name: a session still done after the check is accepted', async (phase) => {
    const engine = makeEngine(undefined, makeFakeCompletionPredicates(phase.predicates(() => {})));
    recordBaselineCommit(h.repo, TEST_BRANCH, 'a'.repeat(40));
    h.defResult = resolved(phase.def());
    enterAndInjectWork(engine);
    engine.onStall();
    writeProgress(exampleGoalProgress(1, 'done'));
    phase.writeResult();
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    await flush();

    expect(engine.liveErrorFor(h.repo)?.reason ?? null).toBeNull();
    expect(readAppLoopState(h.repo)?.status).toBe('complete');
    expect(readAppLoopState(h.repo)?.verdict).toBeUndefined();
  });
});
