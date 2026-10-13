import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoopCompletionPredicates } from '../../src/main/loopCompletionPredicates';
import type { createAppLoopEngine } from '../../src/main/appLoopEngine';
import { examplePhaseResult } from '../../src/shared/phaseResult';
import { INTENDED_FAILURES_HEADING, RED_CHECK_MISSING_WARNING } from '../../src/shared/redCheck';
import { makeFakeCompletionPredicates } from '../helpers/fakeCompletionPredicates';
import { CONSOLIDATE_KEY, REVIEW_KEY, ROSTER, STEP, createAppLoopEngineHarness, flushRedGate } from '../helpers/appLoopEngineHarness';

// §28.5.3 — the RED gate holds the work turn AND every RED review round to the repo's own red-check report,
// and a repo that declares no red check runs unblocked with a warning in each round report.

const h = createAppLoopEngineHarness();
beforeEach(h.setUp);
afterEach(h.tearDown);

type Engine = ReturnType<typeof createAppLoopEngine>;
type RedCheckQuery = Parameters<LoopCompletionPredicates['redCheck']>[0];
const COMMAND = 'node scripts/red-check.mjs';
const REFUSAL = 'the RED check refused: tests/a.test.ts:9 failed but is not a declared intended failure';

const predicates = (opts: { command?: string | null; outcome?: () => Awaited<ReturnType<LoopCompletionPredicates['redCheck']>>; seen?: RedCheckQuery[] }) =>
  makeFakeCompletionPredicates({
    workingTreeTestPaths: async () => ({ ok: true, paths: ['tests/a.test.ts'] }),
    redCheckCommand: () => opts.command ?? null,
    redCheck: async (q) => {
      opts.seen?.push(q);
      return opts.outcome ? opts.outcome() : { kind: 'unconfigured' };
    },
  });

const enterRed = (engine: Engine): void => {
  h.defResult = h.resolved(h.redDef());
  h.enterAndInjectWork(engine);
};
const finishWorkTurn = async (engine: Engine): Promise<void> => {
  h.writeResult(examplePhaseResult('failed-assertion'));
  engine.onDoneSignal();
  await flushRedGate();
};
const reviewInjected = (): string | undefined => h.injected.find((s) => s.includes(ROSTER[0]));
const driveToRedReview = async (engine: Engine): Promise<void> => {
  enterRed(engine);
  await finishWorkTurn(engine);
  engine.onInjectable();
  engine.onInjectable();
};
const finishRound = async (engine: Engine): Promise<void> => {
  h.writeRoundReport(1, []);
  engine.onDoneSignal();
  await flushRedGate();
};
const consolidating = (engine: Engine): boolean => engine.activeTurnKey() === CONSOLIDATE_KEY;

describe('the RED work turn and the red check (§28.5.3)', () => {
  it('tells the agent to run the repo red check and declare its intended failures when one is configured', () => {
    const engine = h.makeEngine(undefined, predicates({ command: COMMAND }));
    enterRed(engine);
    expect(h.injected[1]).toContain(COMMAND);
    expect(h.injected[1]).toContain(INTENDED_FAILURES_HEADING);
  });

  it('holds the RED turn when the red check refuses, surfacing its reason', async () => {
    const engine = h.makeEngine(undefined, predicates({ command: COMMAND, outcome: () => ({ kind: 'refused', reason: REFUSAL }) }));
    enterRed(engine);
    await finishWorkTurn(engine);
    engine.onDoneSignal();
    await flushRedGate();
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('tests/a.test.ts:9'));
    expect(reviewInjected()).toBeUndefined();
  });

  it('completes RED when the red check verifies it', async () => {
    const engine = h.makeEngine(undefined, predicates({ command: COMMAND, outcome: () => ({ kind: 'verified', unchecked: [] }) }));
    await driveToRedReview(engine);
    expect(h.emitError).not.toHaveBeenCalled();
    expect(reviewInjected()).toBeDefined();
  });

  it('completes RED without a configured red check, and the run log says it was not independently checked', async () => {
    const engine = h.makeEngine(undefined, predicates({}));
    await driveToRedReview(engine);
    expect(reviewInjected()).toBeDefined();
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('not independently checked'), null);
  });

  it('writes no unchecked entry to the run log when the red check verified the RED', async () => {
    const engine = h.makeEngine(undefined, predicates({ command: COMMAND, outcome: () => ({ kind: 'verified', unchecked: [] }) }));
    await driveToRedReview(engine);
    expect(h.audit).not.toHaveBeenCalledWith(h.repo, expect.stringContaining('not independently checked'), expect.anything());
  });

  it('completes RED when the declared failures sit in a file the red check does not cover, and the run log names that file', async () => {
    const spec = 'tests/e2e/a.spec.ts';
    const engine = h.makeEngine(undefined, predicates({ command: COMMAND, outcome: () => ({ kind: 'verified', unchecked: [spec] }) }));
    await driveToRedReview(engine);
    expect(reviewInjected()).toBeDefined();
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringMatching(/tests\/e2e\/a\.spec\.ts.*not independently checked/), null);
  });
});

describe('each RED review round and the red check (§28.5.3)', () => {
  it('tells the fixer to re-run the red check when one is configured', async () => {
    const engine = h.makeEngine(undefined, predicates({ command: COMMAND, outcome: () => ({ kind: 'verified', unchecked: [] }) }));
    await driveToRedReview(engine);
    expect(reviewInjected()).toContain(COMMAND);
  });

  it('tells the fixer to carry the missing-check warning in the round report when none is configured', async () => {
    const engine = h.makeEngine(undefined, predicates({}));
    await driveToRedReview(engine);
    expect(reviewInjected()).toContain(RED_CHECK_MISSING_WARNING);
  });

  it('does not complete a round whose red check refuses', async () => {
    let outcome: Awaited<ReturnType<LoopCompletionPredicates['redCheck']>> = { kind: 'verified', unchecked: [] };
    const engine = h.makeEngine(undefined, predicates({ command: COMMAND, outcome: () => outcome }));
    await driveToRedReview(engine);
    outcome = { kind: 'refused', reason: REFUSAL };
    await finishRound(engine);
    engine.onDoneSignal();
    await flushRedGate();
    expect(consolidating(engine)).toBe(false);
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('tests/a.test.ts:9'));
  });

  it('completes a round whose red check verifies, and one with no red check configured', async () => {
    for (const p of [predicates({ command: COMMAND, outcome: () => ({ kind: 'verified', unchecked: [] }) }), predicates({})]) {
      h.tearDown();
      h.setUp();
      const engine = h.makeEngine(undefined, p);
      await driveToRedReview(engine);
      await finishRound(engine);
      expect(consolidating(engine)).toBe(true);
    }
  });

  it('refuses the operator accept of a round whose red check refuses — the check is machine ground truth', async () => {
    let outcome: Awaited<ReturnType<LoopCompletionPredicates['redCheck']>> = { kind: 'verified', unchecked: [] };
    const engine = h.makeEngine(undefined, predicates({ command: COMMAND, outcome: () => outcome }));
    await driveToRedReview(engine);
    outcome = { kind: 'refused', reason: REFUSAL };
    await finishRound(engine);
    engine.onDoneSignal();
    await flushRedGate();
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    await flushRedGate();
    expect(consolidating(engine)).toBe(false);
    expect(engine.liveErrorFor(h.repo)?.reason).toContain('tests/a.test.ts:9');
  });

  it("checks the current slice's RED result, not slice 1's", async () => {
    const seen: RedCheckQuery[] = [];
    const engine = h.makeEngine(undefined, predicates({ command: COMMAND, outcome: () => ({ kind: 'verified', unchecked: [] }), seen }));
    h.currentSliceResult = 2;
    await driveToRedReview(engine);
    await finishRound(engine);
    expect(seen.at(-1)?.resultPath).toMatch(/red-result\.slice-2\.md$/);
  });
});
