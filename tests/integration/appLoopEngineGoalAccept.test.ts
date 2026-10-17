import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { goalProgressRel, goalRefactorResultFile, readAppLoopState, recordBaselineCommit } from '../../src/main/appLoopState';
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

const goal = (def: LoopDefV2): LoopDefV2 => ({ ...def, work: { ...def.work, goal: GOAL }, rounds: { kind: 'none' } });

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
