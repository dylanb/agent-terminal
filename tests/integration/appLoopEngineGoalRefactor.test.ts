import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { goalProgressRel, readAppLoopState, readChangedTests, recordBaselineCommit, refactorResultFile, refactorResultRel } from '../../src/main/appLoopState';
import type { LoopCompletionPredicates } from '../../src/main/loopCompletionPredicates';
import type { LoopDefV2 } from '../../src/main/loopDefV2';
import { exampleGoalProgress } from '../../src/shared/goalProgress';
import { REFACTOR_COMPLETING_OUTCOME } from '../../src/shared/phaseOutcome';
import { examplePhaseResult } from '../../src/shared/phaseResult';
import { makeFakeCompletionPredicates } from '../helpers/fakeCompletionPredicates';
import { createAppLoopEngineHarness, STEP, TEST_BRANCH } from '../helpers/appLoopEngineHarness';

// §27.3/§28.5.3 (v2.201) — a refactor goal session has no engine rounds, so the checks a refactor round runs
// run when the session finishes: its tests still pass, and any test file changed since RED is flagged.

const h = createAppLoopEngineHarness();
const { resolved, makeEngine, enterAndInjectWork } = h;

const refactorGoalDef = (): LoopDefV2 => {
  const base = h.refactorDef();
  return { ...base, work: { ...base.work, goal: 'every reviewer found nothing to fix' }, rounds: { kind: 'none' } };
};
const fake = (overrides: Partial<LoopCompletionPredicates> = {}): LoopCompletionPredicates =>
  makeFakeCompletionPredicates({ changedTestPaths: async () => ({ ok: true, paths: [] }), ...overrides });
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const writeAt = (abs: string, text: string): void => {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
};
const finish = (result: string | null): void => {
  writeAt(join(h.repo, goalProgressRel(readAppLoopState(h.repo)!.goalSession!)), exampleGoalProgress(1, 'done'));
  if (result !== null) writeAt(refactorResultFile(h.repo, 1)!, result);
};
const promptFile = (): string => {
  const cmd = h.injected.find((p) => p.startsWith('/goal '))!;
  return readFileSync(join(h.repo, /\.agent-terminal\/\S+\.md/.exec(cmd)![0]), 'utf8');
};

beforeEach(h.setUp);
afterEach(h.tearDown);

describe('a refactor goal session ends on the refactor checks (§27.3/§28.5.3 v2.201)', () => {
  it('tells the session to record its test result where the check reads it', () => {
    const engine = makeEngine(undefined, fake());
    h.defResult = resolved(refactorGoalDef());
    enterAndInjectWork(engine);

    expect(promptFile()).toContain(refactorResultRel(1));
  });

  it('reaches the gate once the result records the tests passing', async () => {
    const engine = makeEngine(undefined, fake());
    recordBaselineCommit(h.repo, TEST_BRANCH, 'a'.repeat(40));
    h.defResult = resolved(refactorGoalDef());
    enterAndInjectWork(engine);
    finish(examplePhaseResult(REFACTOR_COMPLETING_OUTCOME));
    engine.onDoneSignal();
    await flush();

    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', verdict: 'clean' });
  });

  it('a passing result an earlier run left does not finish a session that records none', async () => {
    writeAt(refactorResultFile(h.repo, 1)!, examplePhaseResult(REFACTOR_COMPLETING_OUTCOME));
    const engine = makeEngine(undefined, fake());
    recordBaselineCommit(h.repo, TEST_BRANCH, 'a'.repeat(40));
    h.defResult = resolved(refactorGoalDef());
    enterAndInjectWork(engine);
    finish(null);
    engine.onDoneSignal();
    await flush();

    expect(readAppLoopState(h.repo)?.status).not.toBe('complete');
  });

  it('clears the earlier result where the check reads it, wherever that is', async () => {
    const elsewhere = join(h.repo, 'elsewhere', 'refactor-result.md');
    writeAt(elsewhere, examplePhaseResult(REFACTOR_COMPLETING_OUTCOME));
    const engine = makeEngine(undefined, fake(), undefined, {
      resolveRefactorResultLocation: () => ({ abs: elsewhere, rel: 'elsewhere/refactor-result.md' }),
    });
    recordBaselineCommit(h.repo, TEST_BRANCH, 'a'.repeat(40));
    h.defResult = resolved(refactorGoalDef());
    enterAndInjectWork(engine);
    finish(null);
    engine.onDoneSignal();
    await flush();

    expect(readAppLoopState(h.repo)?.status).not.toBe('complete');
  });

  it('does not finish when the session records no test result', async () => {
    const engine = makeEngine(undefined, fake());
    h.defResult = resolved(refactorGoalDef());
    enterAndInjectWork(engine);
    finish(null);
    engine.onDoneSignal();
    await flush();

    expect(readAppLoopState(h.repo)?.status).not.toBe('complete');
  });

  it('does not finish when the tests failed', async () => {
    const engine = makeEngine(undefined, fake());
    h.defResult = resolved(refactorGoalDef());
    enterAndInjectWork(engine);
    finish(examplePhaseResult('failed-assertion'));
    engine.onDoneSignal();
    await flush();

    expect(readAppLoopState(h.repo)?.status).not.toBe('complete');
  });

  it('does not finish when the test command exited non-zero', async () => {
    const engine = makeEngine(undefined, fake({ recoverExitCode: async () => 1 }));
    h.defResult = resolved(refactorGoalDef());
    enterAndInjectWork(engine);
    finish(examplePhaseResult(REFACTOR_COMPLETING_OUTCOME));
    engine.onDoneSignal();
    await flush();

    expect(readAppLoopState(h.repo)?.status).not.toBe('complete');
  });

  it('flags a test file changed since RED for the operator, and still finishes', async () => {
    const engine = makeEngine(undefined, fake({ changedTestPaths: async () => ({ ok: true, paths: ['tests/a.test.ts'] }) }));
    recordBaselineCommit(h.repo, TEST_BRANCH, 'a'.repeat(40));
    h.defResult = resolved(refactorGoalDef());
    enterAndInjectWork(engine);
    finish(examplePhaseResult(REFACTOR_COMPLETING_OUTCOME));
    engine.onDoneSignal();
    await flush();

    expect(readAppLoopState(h.repo)?.status).toBe('complete');
    expect(readChangedTests(h.repo)).toEqual({ step: STEP, paths: ['tests/a.test.ts'] });
  });

  it('Accept after a stall runs the same checks and records a changed test file', async () => {
    const engine = makeEngine(undefined, fake({ changedTestPaths: async () => ({ ok: true, paths: ['tests/a.test.ts'] }) }));
    recordBaselineCommit(h.repo, TEST_BRANCH, 'a'.repeat(40));
    h.defResult = resolved(refactorGoalDef());
    enterAndInjectWork(engine);
    engine.onStall();
    finish(examplePhaseResult(REFACTOR_COMPLETING_OUTCOME));
    engine.routeOut(h.repo, STEP, 'work-plan', 'accept');
    await flush();

    expect(readAppLoopState(h.repo)?.status).toBe('complete');
    expect(readChangedTests(h.repo)?.paths).toEqual(['tests/a.test.ts']);
  });

  it('Accept after a stall refuses a test run that exited non-zero', async () => {
    const engine = makeEngine(undefined, fake({ recoverExitCode: async () => 1 }));
    h.defResult = resolved(refactorGoalDef());
    enterAndInjectWork(engine);
    engine.onStall();
    finish(examplePhaseResult(REFACTOR_COMPLETING_OUTCOME));
    engine.routeOut(h.repo, STEP, 'work-plan', 'accept');
    await flush();

    expect(readAppLoopState(h.repo)?.status).toBe('error');
    expect(engine.liveErrorFor(h.repo)?.reason).toContain('exited 1');
  });
});
