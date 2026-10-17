import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_LOOPS_ROOT, bundledFlowOf } from '../helpers/bundledLoops';
import { createAppLoopEngine } from '../../src/main/appLoopEngine';
import { createLoopCompletionPredicates, type LoopCompletionPredicates } from '../../src/main/loopCompletionPredicates';
import { examplePhaseResult, PHASE_RESULT_GRAMMAR } from '../../src/shared/phaseResult';
import { RED_COMPLETING_OUTCOME, GREEN_COMPLETING_OUTCOME, REFACTOR_COMPLETING_OUTCOME } from '../../src/shared/phaseOutcome';
import { GREEN_COMPLETING_BUILD_OUTCOME } from '../../src/shared/buildOutcome';
import { makeFakeCompletionPredicates, deferredWorkingTree, deferredChangedTestPaths } from '../helpers/fakeCompletionPredicates';
import { provideAppLoopView } from '../../src/main/loopViewV2';
import {
  armInterrupt,
  consolidatorOutputRel,
  enterPolish,
  isPolishActiveForStep,
  readAppLoopState,
  readArmedInterrupt,
  recordBaselineCommit,
  readBaselineCommit,
  readChangedTests,
  roundReportFile,
  roundReportRel,
  refactorResultFile,
  refactorResultRel,
  writeAppLoopState,
  type AppLoopRunState,
} from '../../src/main/appLoopState';
import { completionMarker } from '../../src/main/appWorkTurn';
import { exampleRoundReport, REPORT_GRAMMAR } from '../../src/shared/roundReport';
import type { LoopDefV2 } from '../../src/main/loopDefV2';
import type { FlowStateView } from '../../src/shared/ipc';
import {
  CONSOLIDATE_KEY,
  createAppLoopEngineHarness,
  FIXED,
  INJECTED_MARKER,
  REVIEW_KEY,
  ROSTER,
  STEP,
  TEST_BRANCH,
  TURN_KEY,
  binding,
  flushRedGate,
} from '../helpers/appLoopEngineHarness';

// §27.3/§27.12 — the §27 work-turn engine, driven at its observable boundary with REAL fs (the run-state
// file, the completion artifact) and its domain ports as controllable fakes (hostedAgent injectability, the
// stall timer, the injector). The engine reuses the surviving turn state machine (loopOrchestrator) for the
// in-flight mechanics; these tests grade the §27-specific behavior: boundary-then-work injection, the
// artifact-marker completion gate, retry-once-then-error, stall→error without a kill, the identity-carrying
// route-out, and resume that never re-drives a stopped or completed turn.

const h = createAppLoopEngineHarness();
const {
  resolved,
  makeEngine,
  fileDef,
  commitDef,
  refactorDef,
  refactorDefBound,
  redDef,
  writeResult,
  writeArtifact,
  writeRoundReport,
  writeConsolidatorOutput,
  writeReport,
  enterAndInjectWork,
  driveToReviewInjected,
  driveToConsolidateInjected,
  completeConsolidate,
  driveFromWorkToGate,
  advanceReviewToConsolidateInjected,
} = h;
beforeEach(h.setUp);
afterEach(h.tearDown);

describe('§28.5.3 — the engine surfaces the injected machine completion predicates', () => {
  it('surfaces the injected toolkit — its classifyOutcome behavior is observable through the engine', () => {
    // A fresh real toolkit returns null for this marker; the engine yielding the injected verdict proves it
    // exposes the INJECTED instance — observed through behavior, so a behavior-preserving wrapper still passes.
    expect(createLoopCompletionPredicates().classifyOutcome(INJECTED_MARKER)).toBeNull();
    expect(makeEngine().completionPredicates.classifyOutcome(INJECTED_MARKER)).toBe('passed');
  });
});

/** Seed a chained-input artifact on disk and return its realpath — the shape `confineArtifact` yields for
 *  a binding's `path`. */
function seedInputArtifact(absPath: string, content = '# groomed ticket\n'): string {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
  return realpathSync(absPath);
}

/** Seed the chained-input artifact under `dir` and bind the def's single input to it. */
function bindSeededInput(dir: string): string {
  const p = seedInputArtifact(join(dir, '.agent-terminal', 'loop', 'artifacts', 'groomed-ticket.md'));
  h.defResult = resolved({ ...fileDef(), inputs: [binding('groomed-ticket', p)] });
  return p;
}

describe('§28.4 slice D — per-slice result-artifact identity', () => {
  it('a RED work turn entered for slice N names its own slice-keyed result artifact (red-result.slice-N.md), so a re-entered RED writes fresh instead of resuming the prior slice', () => {
    h.defResult = resolved(redDef());
    const engine = makeEngine();
    engine.enter(h.repo, 'red-loop', STEP, 'chain-advance', { slice: 2 });
    engine.onInjectable(); // drain the pre-work boundary so the work prompt injects
    const workPrompt = h.injected[h.injected.length - 1];
    // §28.4 D1 — the prompt must send the agent at slice 2's OWN result file; a re-entered RED that named the
    // static red-result.md would read slice 1's product back and its sync completion clause would pass vacuously.
    expect(workPrompt).toContain('.agent-terminal/loop/artifacts/red-result.slice-2.md');
    expect(workPrompt).not.toContain('.agent-terminal/loop/artifacts/red-result.md');
  });
});

// §28.4.2 — a back-to-RED brief reaches every turn of the reopened slice's RED/GREEN/refactor loops: the work
// prompt (what to redo) and the review-and-fix fixer (what to judge the round against). Other loops never see it.
describe('§28.4.2 — the back-to-RED slice brief reaches the TDD phase turns', () => {
  const BRIEF = { slice: 1, fromStep: 'green', text: 'Cover the empty-input case the tests missed' };

  it('the RED work prompt names the slice redo and carries the brief', () => {
    h.defResult = resolved(redDef());
    const engine = makeEngine();
    h.sliceBriefResult = BRIEF;
    engine.enter(h.repo, 'red-loop', STEP, 'chain-advance', { slice: 1 });
    engine.onInjectable();
    const workPrompt = h.injected[h.injected.length - 1];
    expect(workPrompt).toContain(BRIEF.text);
    expect(workPrompt).toMatch(/redo of impl-slice 1/i);
    expect(workPrompt).toContain('green');
  });

  it('the review-and-fix prompt of a TDD phase loop carries the brief', () => {
    h.defResult = resolved({ ...commitDef(), work: { recipe: join(h.repo, 'recipe', 'work.md'), artifact: 'commits', completion: 'refactor' } });
    const engine = makeEngine();
    h.sliceBriefResult = BRIEF;
    engine.enter(h.repo, 'refactor-loop', STEP, 'chain-advance');
    engine.onInjectable();
    engine.onDoneSignal(); // the refactor work turn is a commits turn → chains the review round
    engine.onInjectable();
    engine.onInjectable();
    const reviewPrompt = h.injected[h.injected.length - 1];
    expect(reviewPrompt).toContain('review-and-fix');
    expect(reviewPrompt).toContain(BRIEF.text);
  });

  it('a loop that is not a TDD phase never sees the brief', () => {
    h.defResult = resolved(fileDef());
    const engine = makeEngine();
    h.sliceBriefResult = BRIEF;
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance');
    engine.onInjectable();
    expect(h.injected[h.injected.length - 1]).not.toContain(BRIEF.text);
  });

  it('no brief, no redo block', () => {
    h.defResult = resolved(redDef());
    const engine = makeEngine();
    engine.enter(h.repo, 'red-loop', STEP, 'chain-advance', { slice: 1 });
    engine.onInjectable();
    expect(h.injected[h.injected.length - 1]).not.toMatch(/redo of impl-slice/i);
  });
});

describe('§28.4 D2 — a RED phase entry clears the prior baseline (#123)', () => {
  const OID = 'a'.repeat(40);
  it('entering a RED work turn clears a stale same-branch baseline, so the next GREEN frozen check blocks rather than stale-matching a prior slice', () => {
    recordBaselineCommit(h.repo, TEST_BRANCH, OID);
    expect(readBaselineCommit(h.repo)).not.toBeNull();
    h.defResult = resolved(redDef());
    makeEngine().enter(h.repo, 'red-loop', STEP, 'chain-advance');
    expect(readBaselineCommit(h.repo)).toBeNull();
  });

  it('entering a GREEN work turn does NOT clear the baseline — GREEN reads it for the frozen check', () => {
    recordBaselineCommit(h.repo, TEST_BRANCH, OID);
    const g = redDef();
    h.defResult = resolved({ ...g, work: { ...g.work, completion: 'green' } });
    makeEngine().enter(h.repo, 'green-loop', STEP, 'chain-advance');
    expect(readBaselineCommit(h.repo)).not.toBeNull();
  });

  // §28.4 D2 (CWE-703/755) — the RED-entry baseline clear is best-effort, the same discipline the approve path
  // pins for its clear-polish failure: a throwing clearBaseline (an unresolvable loop area) must NOT abort the
  // entry, or the operator is stranded with a step whose RED turn never starts, and the failure is audited, never
  // swallowed (§25 audit-truth) so the degraded state is visible before the next frozen check.
  it('a throwing clearBaseline never aborts the RED entry — the work turn still starts, and the failure is audited', () => {
    recordBaselineCommit(h.repo, TEST_BRANCH, OID);
    h.defResult = resolved(redDef());
    const engine = makeEngine(); // resets the toggles, so arm the throw AFTER (as the clear-polish sibling does)
    h.clearBaselineError = 'EISDIR: illegal operation on a directory'; // …and clearing the baseline will throw
    const before = h.injected.length;
    expect(() => engine.enter(h.repo, 'red-loop', STEP, 'chain-advance')).not.toThrow();
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected.slice(before).some((p) => p.includes('Produce the plan.'))).toBe(true); // the RED turn started anyway
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('clear-baseline'), 1); // recorded, not swallowed
  });
});

describe('§27.4 — a review round runs only when every reviewer is installed carrying this run\'s charter', () => {
  const MISSING = 'review-plan-security';
  const problemFor = (missing: () => boolean) => (reviewer: { loop: string; persona: string }): string | null =>
    missing() && reviewer.persona === MISSING ? `no sub-agent ${reviewer.loop}--${reviewer.persona} is installed` : null;

  it('refuses the review round before injecting it, naming the reviewer, while the work turn ran as usual', () => {
    const engine = makeEngine(undefined, undefined, undefined, { reviewerAgentProblem: problemFor(() => true) });
    enterAndInjectWork(engine);
    expect(h.injected.some((p) => p.includes('Produce the plan.'))).toBe(true);
    writeArtifact(true);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected.some((p) => p.includes('review-and-fix turn'))).toBe(false);
    const live = engine.liveErrorFor(h.repo);
    expect(live?.kind).toBe('turn-error');
    expect(live?.reason).toContain(`no sub-agent plan-loop--${MISSING} is installed`);
    expect(live?.reason).toMatch(/restart your agent session/i);
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'error' });
  });

  it('Retry stays refused while a reviewer is still missing, and runs the round once it is installed', () => {
    let missing = true;
    const engine = makeEngine(undefined, undefined, undefined, { reviewerAgentProblem: problemFor(() => missing) });
    enterAndInjectWork(engine);
    writeArtifact(true);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
    expect(engine.liveErrorFor(h.repo)?.reason).toContain(MISSING);

    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected.some((p) => p.includes('review-and-fix turn'))).toBe(false);

    missing = false;
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected.some((p) => p.includes('review-and-fix turn'))).toBe(true);
    expect(engine.liveErrorFor(h.repo)).toBeNull();
  });
});

describe('§27.10 — every turn after pickup runs on the branch pickup created', () => {
  const PICKUP_BRANCH = 'plan-loop/issue-180';
  const OTHER_BRANCH = 'fix/review-subject-artifact';
  const ON_PICKUP = { kind: 'branch', branch: PICKUP_BRANCH } as const;

  it('a work turn on a different branch than pickup created injects no prompt and summons the human, naming both branches', () => {
    const engine = makeEngine(undefined, undefined, OTHER_BRANCH, { pickupBranch: () => ON_PICKUP });
    enterAndInjectWork(engine);
    engine.onInjectable();
    expect(h.injected.some((p) => p.includes('Produce the plan.'))).toBe(false);
    const live = engine.liveErrorFor(h.repo);
    expect(live?.kind).toBe('turn-error');
    expect(live?.reason).toContain(PICKUP_BRANCH);
    expect(live?.reason).toContain(OTHER_BRANCH);
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'error' });
    expect(h.audit.mock.calls.filter(([, cmd]) => String(cmd).includes('boundary'))).toEqual([]);
  });

  it('a detached HEAD is not the pickup branch either', () => {
    const engine = makeEngine(undefined, undefined, null, { pickupBranch: () => ON_PICKUP });
    enterAndInjectWork(engine);
    expect(h.injected.some((p) => p.includes('Produce the plan.'))).toBe(false);
    expect(engine.liveErrorFor(h.repo)?.reason).toContain(PICKUP_BRANCH);
  });

  it('a branch switched mid-step stops the next turn before it injects', () => {
    let branch: string | null = PICKUP_BRANCH;
    const engine = makeEngine(undefined, undefined, null, {
      pickupBranch: () => ON_PICKUP,
      currentBranch: () => ({ ok: true, branch }),
    });
    enterAndInjectWork(engine);
    expect(h.injected.some((p) => p.includes('Produce the plan.'))).toBe(true);
    branch = OTHER_BRANCH;
    writeArtifact(true);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected.some((p) => p.includes(REVIEW_KEY))).toBe(false);
    expect(engine.liveErrorFor(h.repo)?.reason).toContain(OTHER_BRANCH);
    expect(h.audit.mock.calls.filter(([, cmd]) => String(cmd).includes('review round 1 boundary'))).toEqual([]);
  });

  it('a branch probe that fails is reported with its own reason, not as a detached HEAD', () => {
    const engine = makeEngine(undefined, undefined, null, {
      pickupBranch: () => ON_PICKUP,
      currentBranch: () => ({ ok: false, detail: 'fatal: not a git repository' }),
    });
    enterAndInjectWork(engine);
    expect(h.injected.some((p) => p.includes('Produce the plan.'))).toBe(false);
    const reason = engine.liveErrorFor(h.repo)?.reason ?? '';
    expect(reason).toContain('fatal: not a git repository');
    expect(reason).toContain(PICKUP_BRANCH);
    expect(reason).not.toContain('detached');
  });

  it('an unreadable pickup record refuses the turn with its read error instead of lifting the guard', () => {
    const engine = makeEngine(undefined, undefined, OTHER_BRANCH, {
      pickupBranch: () => ({ kind: 'unreadable', detail: '.agent-terminal/loop/bootstrap.yaml is not valid YAML' }),
    });
    enterAndInjectWork(engine);
    expect(h.injected.some((p) => p.includes('Produce the plan.'))).toBe(false);
    const reason = engine.liveErrorFor(h.repo)?.reason ?? '';
    expect(reason).toContain('.agent-terminal/loop/bootstrap.yaml is not valid YAML');
    expect(reason).toContain('terminate the run');
    expect(reason).not.toMatch(/remove/i);
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'error' });
  });

  it('Retry stays refused while the branch is still wrong, and injects once the pickup branch is checked out', () => {
    let branch: string | null = OTHER_BRANCH;
    const engine = makeEngine(undefined, undefined, null, {
      pickupBranch: () => ON_PICKUP,
      currentBranch: () => ({ ok: true, branch }),
    });
    enterAndInjectWork(engine);
    expect(engine.liveErrorFor(h.repo)?.reason).toContain(OTHER_BRANCH);

    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected).toEqual([]);
    expect(engine.liveErrorFor(h.repo)?.reason).toContain(OTHER_BRANCH);
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'error' });

    branch = PICKUP_BRANCH;
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected.some((p) => p.includes('Produce the plan.'))).toBe(true);
    expect(engine.liveErrorFor(h.repo)).toBeNull();
    expect(readAppLoopState(h.repo)?.status).toBe('working');
  });

  it('a turn on the pickup branch injects as usual', () => {
    const engine = makeEngine(undefined, undefined, PICKUP_BRANCH, { pickupBranch: () => ON_PICKUP });
    enterAndInjectWork(engine);
    expect(h.injected.some((p) => p.includes('Produce the plan.'))).toBe(true);
    expect(engine.liveErrorFor(h.repo)).toBeNull();
  });

  it('a run with no pickup branch is not held to one', () => {
    const engine = makeEngine(undefined, undefined, OTHER_BRANCH, { pickupBranch: () => ({ kind: 'none' }) });
    enterAndInjectWork(engine);
    expect(h.injected.some((p) => p.includes('Produce the plan.'))).toBe(true);
  });
});

describe('§27 engine — entry, boundary, and the work injection (AC1, AC9)', () => {
  it('injects the declared boundary command FIRST, then the work prompt, and persists status working', () => {
    const engine = makeEngine();
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance');
    expect(h.injected[0]).toBe('/clear'); // the def's pre-work boundary, before any work prompt
    expect(readAppLoopState(h.repo)).toMatchObject({ loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'working' });
    engine.onInjectable(); // boundary drained + idle-confirm
    expect(h.injected[1]).toContain('Produce the plan.'); // the recipe body
    expect(h.injected[1]).toContain(completionMarker(STEP)); // the marker instruction
    expect(h.injected[1]).toContain('turn-done:work-plan'); // the §27 done-signal
    expect(engine.activeTurnKey()).toBe(TURN_KEY);
    // AC9 — the boundary is recorded in the §25 audit (no round/iteration event, exit null).
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('/clear'), null);
  });

  it('binds the injected work prompt to the flow-resolved ticket, not one inferred from the branch', () => {
    // Regression (the groom-from-another-ticket's-branch corruption): the engine must name the ticket the flow
    // resolved — the SAME identity the gate's update-issue-body writes to — so the agent works that issue rather
    // than inferring it from ambient state. Observed at the injected prompt, the turn's own boundary.
    const engine = makeEngine(); // resets workRefsResult, so set the resolved ticket after construction
    h.workRefsResult = { ticket: 133, pr: null };
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance');
    engine.onInjectable(); // boundary drained + idle-confirm → the work prompt injects
    expect(h.injected[1]).toContain('#133');
    expect(h.injected[1].toLowerCase()).toContain('do not infer');
  });

  it('emits no ticket line in the work prompt when the flow resolved no ticket', () => {
    h.workRefsResult = { ticket: null, pr: null };
    const engine = makeEngine();
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance');
    engine.onInjectable();
    expect(h.injected[1].toLowerCase()).not.toContain('this loop is working github issue');
  });

  it('§19.1 — binds the injected consolidator prompt to the flow-resolved ticket it judges the round against', () => {
    const engine = makeEngine(); // resets workRefsResult, so set the resolved ticket after construction
    h.workRefsResult = { ticket: 133, pr: null };
    driveToConsolidateInjected(engine);
    expect(h.injected[h.injected.length - 1]).toContain('#133'); // the same issue the work turn and gate bind to
  });

  it('§19.1 — binds the injected review-and-fix prompt to the flow-resolved ticket it hands each reviewer', () => {
    const engine = makeEngine();
    h.workRefsResult = { ticket: 133, pr: null };
    driveToReviewInjected(engine);
    expect(h.injected[h.injected.length - 1]).toContain('#133'); // each reviewer is handed THIS ticket, not an inferred one
  });

  it('§27.8 — a def that defers polish tells the review-and-fix round to dismiss polish-only findings', () => {
    h.defResult = resolved({ ...fileDef(), report: { sections: ['summary'], polish: 'defer' } });
    const engine = makeEngine();
    driveToReviewInjected(engine);
    expect(h.injected[h.injected.length - 1]).toMatch(/polish[\s\S]*`dismissed — out of scope`[\s\S]*later loop/i);
  });

  it('§27.8 — a def that fixes polish injects no deferral clause', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    expect(h.injected[h.injected.length - 1]).not.toMatch(/polish[\s\S]*`dismissed — out of scope`[\s\S]*later loop/i);
  });

  it('a compact boundary issues /compact carrying the def message (§27.9)', () => {
    h.defResult = resolved({ ...fileDef(), boundaries: [{ boundary: 'pre-work', mode: 'compact', message: 'Keep the plan.' }] });
    const engine = makeEngine();
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance');
    expect(h.injected[0]).toBe('/compact Keep the plan.');
  });

  it('does not start a turn or write run-state when the def fails to resolve (AC6 handled at the view)', () => {
    h.defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' };
    const engine = makeEngine();
    expect(engine.canEnter()).toBe(true);
    expect(engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance')).toBe('unresolved');
    expect(engine.canEnter()).toBe(true);
    expect(h.injected).toEqual([]);
    expect(readAppLoopState(h.repo)).toBeNull();
  });

  it('refuses a second entry while a turn is in flight (AC4 — not interleaved)', () => {
    const engine = makeEngine();
    expect(engine.canEnter()).toBe(true);
    expect(engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance')).toBe('entered');
    expect(engine.canEnter()).toBe(false);
    engine.onInjectable();
    const count = h.injected.length;
    expect(engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance')).toBe('busy');
    expect(h.injected.length).toBe(count);
  });
});

// §B.20a / §B.5 item 6 (AC10) — a step whose bound def declares a `pickup:` block has its skill injected by
// the COORDINATOR after work entry is accepted, so `enter` must ACCEPT the turn WITHOUT REQUESTING it: it
// answers 'entered' having deferred `start`'s `requestTurn` to a caller-supplied trigger the coordinator fires
// from the injection's completion. The accepted-but-not-yet-requested turn OCCUPIES the runner (a second entry
// in the gap is refused), and the deferral is abandonable so the coordinator's deadline-lapse revert frees it.
describe('§27 engine — deferred work-turn request (§B.20a / §B.5 item 6)', () => {
  it('deferRequest accepts the turn WITHOUT requesting it — nothing injected, runner occupied, second entry busy', () => {
    const engine = makeEngine();
    h.hosted = 'idle'; // an idle instance would inject the boundary synchronously on the initial arm — the deferral must not
    expect(engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance', { deferRequest: true })).toBe('entered');
    expect(h.injected).toEqual([]); // the request is deferred — no boundary drained, no prompt
    expect(engine.canEnter()).toBe(false); // the accepted turn occupies the runner across the gap
    expect(engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance', { deferRequest: true })).toBe('busy');
    expect(h.injected).toEqual([]);
    // the turn identity is available for the host's done-watch even before the request fires
    expect(engine.activeTurnKey()).toBe(TURN_KEY);
  });

  it('triggerDeferredTurn requests the deferred turn on the CHAINED arm (boundary then work prompt)', () => {
    const engine = makeEngine();
    h.hosted = 'idle';
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance', { deferRequest: true });
    expect(h.injected).toEqual([]);
    engine.triggerDeferredTurn();
    // chained arm: re-arm quiescence and wait for a FRESH settle — nothing injected until onInjectable
    expect(h.injected).toEqual([]);
    engine.onInjectable(); // the fresh settle drains the boundary preamble
    expect(h.injected[0]).toBe('/clear');
    engine.onInjectable(); // the boundary drains → the work prompt injects
    expect(h.injected[1]).toContain('Produce the plan.');
    expect(engine.canEnter()).toBe(false); // genuinely in-flight now
  });

  it('cancelDeferredTurn abandons a deferred turn — frees the runner, injects nothing, no active turn', () => {
    const engine = makeEngine();
    h.hosted = 'idle';
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance', { deferRequest: true });
    expect(engine.canEnter()).toBe(false);
    engine.cancelDeferredTurn();
    expect(engine.canEnter()).toBe(true); // the runner is free again
    expect(h.injected).toEqual([]); // nothing was ever injected
    expect(engine.activeTurnKey()).toBeNull(); // no turn lingers un-requested
  });

  it('a bare enter (no opts) still requests synchronously — the deferral is opt-in only (AC2)', () => {
    const engine = makeEngine();
    h.hosted = 'idle';
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance');
    expect(h.injected[0]).toBe('/clear'); // today's initial-arm behavior, unchanged
  });
});

// §27.10/§27.9 / N6 (sub-ticket 1) — an approved loop's output artifact, resolved as the next loop's typed
// input (§27.10), is the material the next loop's work turn is entered with. The engine reads the entered def's
// declared inputs; only an input whose artifact is actually PRESENT on disk (the prior loop produced it) is
// carried in and recorded as a chained transition, so a loop entered with no upstream artifact chains nothing.
describe('§27 engine — chained input into the work turn (AC1)', () => {
  const CHAINED_INPUT_PATH = () => join(h.repo, '.agent-terminal', 'loop', 'artifacts', 'groomed-ticket.md');
  const CHAINED_INPUT_REL = '.agent-terminal/loop/artifacts/groomed-ticket.md';
  function chainedDef(): LoopDefV2 {
    return { ...fileDef(), inputs: [binding('groomed-ticket', CHAINED_INPUT_PATH())] };
  }

  it('carries a present input artifact into the work prompt and records the chained transition (AC1)', () => {
    // the prior loop's output sits at the next loop's declared input path (realpath'd, as confineArtifact yields it)
    bindSeededInput(h.repo);
    const engine = makeEngine();
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance');
    engine.onInjectable(); // boundary drains → the work prompt injects
    expect(h.injected[1]).toContain(`- groomed-ticket: ${CHAINED_INPUT_REL}`); // the resolved input carried in
    // The chained transition is recorded in the §25 audit, naming the entered step and the carried artifact id.
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('groomed-ticket'), 0);
    const chainCall = h.audit.mock.calls.find((c) => /chained transition/i.test(c[1]));
    expect(chainCall).toBeDefined();
    expect(chainCall![1]).toContain(STEP); // into the entered step (§6 identity)
  });

  it('carries only the present artifact when one of two declared inputs is absent (per-element gate, not all-or-nothing)', () => {
    const PLAN_INPUT_REL = '.agent-terminal/loop/artifacts/plan-input.md';
    // only this input's artifact exists on disk (realpath'd, as confineArtifact yields it)
    const planInputPath = seedInputArtifact(join(h.repo, '.agent-terminal', 'loop', 'artifacts', 'plan-input.md'), '# plan\n');
    h.defResult = resolved({
      ...fileDef(),
      inputs: [
        binding('groomed-ticket', CHAINED_INPUT_PATH()), // declared, never produced
        binding('plan-input', planInputPath),
      ],
    });
    const engine = makeEngine();
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance');
    engine.onInjectable();
    expect(h.injected[1]).toContain(`- plan-input: ${PLAN_INPUT_REL}`); // the present one is carried
    expect(h.injected[1]).not.toContain(CHAINED_INPUT_REL); // the absent one is filtered per-element
    const chainCall = h.audit.mock.calls.find((c) => /chained transition/i.test(c[1]));
    expect(chainCall).toBeDefined();
    expect(chainCall![1]).toContain('plan-input'); // what was carried
    expect(chainCall![1]).toContain('groomed-ticket'); // and what was declared but did not chain
    expect(chainCall![2]).toBe(1); // a chain that did not fully carry is a non-zero event
  });

  it('records the declared input that did not chain, so a broken chain is not silent (present-gated carry)', () => {
    h.defResult = resolved(chainedDef()); // declares the input, but the artifact was never produced
    const engine = makeEngine();
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance');
    engine.onInjectable();
    expect(h.injected[1]).not.toContain(CHAINED_INPUT_REL); // nothing to carry → no chained-input block
    const chainCall = h.audit.mock.calls.find((c) => /chained transition/i.test(c[1]));
    expect(chainCall).toBeDefined(); // a declared-but-unresolved input is a fact the timeline must carry
    expect(chainCall![1]).toContain('groomed-ticket');
    expect(chainCall![2]).toBe(1); // a chain that did not fully carry is a non-zero event
    // Absent is not the operator's problem to fix — only an unreadable artifact is surfaced as an error.
    expect(h.emitError).not.toHaveBeenCalled();
  });

  it('carries nothing and records nothing when a run STARTS at this step (no upstream loop ran)', () => {
    // A leftover artifact from an earlier run sits at the declared input path — nothing clears the artifacts
    // subtree. Starting a fresh run here is not a chain advance, so that file is not the previous loop's
    // approved output and must not be announced to the agent as one.
    bindSeededInput(h.repo);
    const engine = makeEngine();
    engine.enter(h.repo, 'plan-loop', STEP, 'fresh-run');
    engine.onInjectable();
    expect(h.injected[1]).not.toContain(CHAINED_INPUT_REL);
    expect(h.audit.mock.calls.some((c) => /chained transition/i.test(c[1]))).toBe(false);
  });

  it('re-carries what the step\'s entry carried, without recording a second transition, when the step is RE-entered', () => {
    bindSeededInput(h.repo);
    const engine = makeEngine();
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance'); // the entry that established the carry
    engine.onInjectable();
    const chainedBefore = h.audit.mock.calls.filter((c) => /chained transition/i.test(c[1])).length;
    engine.onStall(); // the turn leaves flight, so the step can be re-entered
    const before = h.injected.length;
    engine.enter(h.repo, 'plan-loop', STEP, 're-entry');
    engine.onInjectable();
    engine.onInjectable();
    const prompt = h.injected.slice(before).find((p) => p.includes('Produce the plan.'));
    expect(prompt).toContain(`- groomed-ticket: ${CHAINED_INPUT_REL}`); // the turn still gets its material
    const chainedAfter = h.audit.mock.calls.filter((c) => /chained transition/i.test(c[1])).length;
    expect(chainedAfter).toBe(chainedBefore); // but the re-entry is not itself a chain advance
  });

  it('surfaces a declared input that exists but cannot be read, rather than treating it as never produced', () => {
    // A directory planted at the artifact path (or an artifact written under another uid) is EISDIR/EACCES,
    // not ENOENT: the upstream loop's product is unavailable, which is not the same fact as "no upstream ran".
    // Conflating them enters the work turn with no plan and leaves the §25 timeline blank.
    const iPath = CHAINED_INPUT_PATH();
    mkdirSync(iPath, { recursive: true }); // a directory where the artifact belongs
    h.defResult = resolved({ ...fileDef(), inputs: [binding('groomed-ticket', iPath)] });
    const engine = makeEngine();
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance');
    engine.onInjectable();
    expect(h.injected[1]).not.toContain(CHAINED_INPUT_REL); // still not carried — it cannot be read
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('groomed-ticket'));
    const chainCall = h.audit.mock.calls.find((c) => /chained transition/i.test(c[1]));
    expect(chainCall).toBeDefined(); // the broken chain is recorded, not silent
    expect(chainCall![1]).toContain('groomed-ticket');
    expect(chainCall![2]).toBe(1); // a chain that did not fully carry is a non-zero event
  });

  it('a loop declaring no inputs records no chained transition (the first loop in a chain)', () => {
    h.defResult = resolved(fileDef()); // inputs: []
    const engine = makeEngine();
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance');
    engine.onInjectable();
    expect(h.audit.mock.calls.some((c) => /chained transition/i.test(c[1]))).toBe(false);
  });

  it('embeds the binding rel the def parser composed, never one re-derived from the repo root', () => {
    // The parser owns where an artifact sits (loopDefV2 `confineArtifact` composes `path` and `rel` from one
    // segment list); the engine must carry that `rel` through verbatim. A sentinel no path arithmetic against
    // repoDir could produce is what makes this fail if the engine re-derives — the defect class commit c0292b4
    // fixed by canonicalizing the left operand instead of removing the arithmetic.
    const iPath = seedInputArtifact(CHAINED_INPUT_PATH());
    const sentinelRel = 'sentinel/loop-area/groomed-ticket.md';
    h.defResult = resolved({ ...commitDef(), inputs: [{ id: 'groomed-ticket', path: iPath, rel: sentinelRel }] });
    const engine = makeEngine();
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance');
    engine.onInjectable();
    expect(h.injected[1]).toContain(`- groomed-ticket: ${sentinelRel}`);
  });

  it('embeds the completion binding rel the def parser composed for the work turn\'s own artifact', () => {
    const sentinelRel = 'sentinel/loop-area/plan.md';
    h.defResult = resolved({ ...fileDef(), outputs: [{ id: 'plan', path: h.artifactPath, rel: sentinelRel }] });
    const engine = makeEngine();
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance');
    engine.onInjectable();
    expect(h.injected[1]).toContain(`your ${sentinelRel} artifact`);
  });
});

describe('§27 engine — work completion gate + review chain (AC2, AC3)', () => {
  it('a marker-bearing artifact completes the WORK turn and chains the pre-review boundary + review prompt (AC1)', () => {
    const engine = makeEngine();
    enterAndInjectWork(engine);
    const afterWork = h.injected.length;
    writeArtifact(true);
    engine.onDoneSignal(); // work done-signal → work complete, chain the review-and-fix turn (§27.3)
    engine.onInjectable(); // the pre-review boundary drains
    expect(h.injected[afterWork]).toBe('/compact Keep the plan and the ticket.'); // the def's pre-review boundary
    engine.onInjectable(); // the review-and-fix prompt injects
    expect(h.injected[afterWork + 1]).toContain(ROSTER[0]); // the roster is conveyed (AC2)
    expect(h.injected[afterWork + 1]).toContain(ROSTER[1]);
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'working', round: 1 });
    expect(engine.activeTurnKey()).toBe(REVIEW_KEY);
  });

  it('a def declaring no work artifact completes the work turn on the done-signal alone, then chains review (AC3)', () => {
    h.defResult = resolved(commitDef());
    const engine = makeEngine();
    enterAndInjectWork(engine);
    engine.onDoneSignal(); // work completes on the done-signal → chains review
    expect(h.readArtifact).not.toHaveBeenCalled(); // commit-producing work turn: no artifact read
    expect(readAppLoopState(h.repo)?.turnKey).toBe(REVIEW_KEY); // advanced into the review turn
  });

  it('an artifact present but missing the marker triggers one retry, then error (AC3, AC5)', () => {
    const engine = makeEngine();
    enterAndInjectWork(engine);
    const afterWork = h.injected.length;
    writeArtifact(false); // present but no marker
    engine.onDoneSignal(); // first failure → one re-injection of the same turn
    expect(h.injected.length).toBe(afterWork + 1);
    expect(readAppLoopState(h.repo)?.status).not.toBe('error'); // not yet
    engine.onDoneSignal(); // second failure → error
    const state = readAppLoopState(h.repo);
    expect(state?.status).toBe('error');
    expect(state?.errorReason).toBeTruthy();
    expect(h.emitError).toHaveBeenCalledTimes(1);
    // AC7 — the failure is recorded in the §25 audit with its reason (exit 1).
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining(state!.errorReason!), 1);
  });
});

describe('§27 engine — stall (AC6)', () => {
  it('a stall resolves to error without retrying and without a kill (process left alive to inspect)', () => {
    const engine = makeEngine();
    enterAndInjectWork(engine);
    const afterWork = h.injected.length;
    engine.onStall();
    expect(h.injected.length).toBe(afterWork); // NOT re-injected
    const state = readAppLoopState(h.repo);
    expect(state?.status).toBe('error');
    expect(state?.errorReason).toMatch(/stall/i);
    // No kill port exists on the engine — the instance's process is untouched by design.
  });

  it('the agent writing its done file after a stall completes the turn and clears the error (§27.12)', () => {
    const engine = makeEngine();
    enterAndInjectWork(engine);
    engine.onStall();
    expect(readAppLoopState(h.repo)?.status).toBe('error');
    writeArtifact(true);
    engine.onDoneSignal();
    const state = readAppLoopState(h.repo);
    expect(state?.status).toBe('working');
    expect(state?.turnKey).not.toBe(TURN_KEY); // advanced to the review round
    expect(engine.liveErrorFor(h.repo)).toBeNull();
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('resumed after a stall'), 0);
  });

  it('a done file after the operator accepted a stalled turn does not advance it a second time', () => {
    const engine = makeEngine();
    enterAndInjectWork(engine);
    engine.onStall();
    writeArtifact(true);
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    expect(readAppLoopState(h.repo)?.status).toBe('complete');
    engine.onDoneSignal();
    expect(readAppLoopState(h.repo)?.status).toBe('complete');
    expect(h.audit).not.toHaveBeenCalledWith(h.repo, expect.stringContaining('resumed after a stall'), 0);
  });

  it('a done file after the stalled turn was released (its flow terminated) does not resume it', () => {
    const engine = makeEngine();
    enterAndInjectWork(engine);
    engine.onStall();
    writeArtifact(true);
    engine.releaseStalledTurn(h.repo);
    engine.onDoneSignal();
    expect(readAppLoopState(h.repo)?.status).toBe('error');
    expect(h.audit).not.toHaveBeenCalledWith(h.repo, expect.stringContaining('resumed after a stall'), 0);
  });

  it('a Terminate the flow refuses (it never reset the run) leaves the stalled turn resumable', () => {
    const engine = makeEngine();
    h.terminateFlow.mockReturnValueOnce({ outcome: 'refused', cause: 'locked', reason: 'held by a peer', view: {} as FlowStateView });
    enterAndInjectWork(engine);
    engine.onStall();
    writeArtifact(true);
    engine.routeOut(h.repo, STEP, TURN_KEY, 'terminate');
    expect(h.terminateFlow).toHaveBeenCalledWith(h.repo);
    engine.onDoneSignal();
    expect(readAppLoopState(h.repo)?.status).toBe('working');
  });

  it('releasing a different worktree leaves the stalled turn resumable', () => {
    const engine = makeEngine();
    enterAndInjectWork(engine);
    engine.onStall();
    writeArtifact(true);
    engine.releaseStalledTurn(join(tmpdir(), 'some-other-repo'));
    engine.onDoneSignal();
    expect(readAppLoopState(h.repo)?.status).toBe('working');
  });

  it('visible activity re-arms the stall watchdog while in flight (a long streaming turn never stalls)', () => {
    const engine = makeEngine();
    enterAndInjectWork(engine);
    h.armTimer.mockClear();
    engine.noteActivity();
    engine.noteActivity();
    expect(h.armTimer).toHaveBeenCalledTimes(2);
  });
});

describe('§27 engine — a persist failure never aborts the error path (CWE-703/755, AC7)', () => {
  it('does not let a status:error write throw escape the stall callback, and still surfaces the error', () => {
    // The §27 loop-state write can fail (ENOSPC/EPERM/EROFS/a planted symlink). That best-effort resume
    // write must never throw into the stall/done-file callbacks (it would crash main — there is no
    // uncaughtException handler), and the error must still be surfaced so the route-out stays reachable.
    const engine = makeEngine((repoDir, state) => {
      if (state.status === 'error') throw new Error('ENOSPC: no space left on device');
      writeAppLoopState(repoDir, state, FIXED);
    });
    enterAndInjectWork(engine);
    expect(() => engine.onStall()).not.toThrow();
    expect(h.emitError).toHaveBeenCalledTimes(1);
  });

  it('surfaces the live error to the view even when the status:error write failed (route-out not a dead-end)', () => {
    const engine = makeEngine((repoDir, state) => {
      if (state.status === 'error') throw new Error('EROFS: read-only file system');
      writeAppLoopState(repoDir, state, FIXED);
    });
    enterAndInjectWork(engine);
    engine.onStall();
    // The persisted file could not record the error, but the engine holds the live error so the view can
    // still render the §27 route-out (retry / accept / terminate) for THIS repo.
    const live = engine.liveErrorFor(h.repo);
    expect(live).toMatchObject({ loop: 'plan-loop', step: STEP, turnKey: TURN_KEY });
    expect(live?.reason).toBeTruthy();
    expect(engine.liveErrorFor(join(tmpdir(), 'some-other-repo'))).toBeNull();
  });

  it('clears the held live error when the turn transitions back out of error (retry → working)', () => {
    // The live error is held only while the turn is in `error`; a transition to any non-error status must
    // clear it, or the view would keep rendering stale retry/accept/terminate controls over a now-working
    // turn and let the operator route-out against a live turn. Set up a failed error-persist so the live
    // error is populated, then drive a retry back to `working` and assert the hold is released.
    const engine = makeEngine((repoDir, state) => {
      if (state.status === 'error') throw new Error('EROFS: read-only file system');
      writeAppLoopState(repoDir, state, FIXED);
    });
    enterAndInjectWork(engine);
    engine.onStall();
    expect(engine.liveErrorFor(h.repo)).not.toBeNull(); // held after the failed error-persist
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry'); // transitions to `working`
    expect(engine.liveErrorFor(h.repo)).toBeNull(); // the non-error persist released the hold
  });
});

describe('§27 engine — the identity-carrying route-out (AC7)', () => {
  function toError(engine: ReturnType<typeof createAppLoopEngine>): void {
    enterAndInjectWork(engine);
    engine.onStall();
  }

  it('retry re-enters the same work turn (boundary + work), never on ambient state', () => {
    const engine = makeEngine();
    toError(engine);
    const afterError = h.injected.length;
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    engine.onInjectable(); // boundary drains
    engine.onInjectable(); // work re-injects
    expect(h.injected.length).toBeGreaterThan(afterError);
    expect(readAppLoopState(h.repo)?.status).toBe('working');
  });

  it('accept advances a present artifact to complete WITHOUT re-running or injecting (AC7)', () => {
    const engine = makeEngine();
    toError(engine);
    writeArtifact(true); // the artifact is actually present
    const afterError = h.injected.length;
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    expect(readAppLoopState(h.repo)?.status).toBe('complete');
    expect(h.injected.length).toBe(afterError); // never injects
  });

  it('accept with no present artifact does not advance (retry is the path)', () => {
    const engine = makeEngine();
    toError(engine);
    h.emitError.mockClear(); // isolate the refused-Accept call from the stall→error emit
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept'); // artifact absent, but the def RESOLVED
    expect(readAppLoopState(h.repo)?.status).toBe('error');
    expect(h.emitError).not.toHaveBeenCalled(); // a resolved-absent refusal is SILENT — Retry is the affordance
    expect(engine.liveErrorFor(h.repo)?.kind).toBe('turn-error'); // the retained stall error keeps its kind — the refusal never flips it to def-unresolvable
  });

  it('terminate moves the flow off the step', () => {
    const engine = makeEngine();
    toError(engine);
    engine.routeOut(h.repo, STEP, TURN_KEY, 'terminate');
    expect(h.terminateFlow).toHaveBeenCalledWith(h.repo);
  });

  it('a route-out naming a DIFFERENT turn is ignored (§6 — acts on the payload identity, not ambient)', () => {
    const engine = makeEngine();
    toError(engine);
    const afterError = h.injected.length;
    engine.routeOut(h.repo, STEP, 'work-someone-else', 'retry');
    expect(h.injected.length).toBe(afterError); // did not re-drive a turn it does not name
    expect(readAppLoopState(h.repo)?.status).toBe('error');
  });
});

describe('§27 engine — resume (AC8)', () => {
  it('reconstructs a persisted error and does NOT re-drive it; retry then acts on the right turn', () => {
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'error', errorReason: 'stalled: no terminal activity' }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    expect(h.injected).toEqual([]); // an error is human-owned — never re-driven on resume
    expect(readAppLoopState(h.repo)?.status).toBe('error');
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry'); // acts on the reconstructed turn
    expect(readAppLoopState(h.repo)?.status).toBe('working');
  });

  it('refuses Accept after resume when the def no longer resolves — no unverified complete (CWE-754)', () => {
    // The bound def was deleted/edited between runs, so resume cannot reconstruct the real completion
    // contract. Accept must NOT mark the file-producing turn complete without validating an artifact — it
    // reconstructs an UNRESOLVED turn, and Accept refuses (Retry/Terminate remain the route out).
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'error', errorReason: 'stalled' }, FIXED);
    h.defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' };
    const engine = makeEngine();
    engine.resume(h.repo);
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    expect(readAppLoopState(h.repo)?.status).toBe('error'); // Accept refused: not fabricated complete
    expect(h.injected).toEqual([]); // and never injected
  });

  it('surfaces a def-unresolvable error when Accept is refused on an unresolved resumed turn (CWE-755)', () => {
    // Refusing Accept silently leaves the operator staring at the stale ORIGINAL error reason (e.g. `stall`)
    // with an Accept affordance that can never succeed and no feedback saying so. The refusal must surface a
    // def-unresolvable reason via emitError (and update the live error) so the view tells the operator to
    // retry or terminate — the exceptional condition is detected AND reported, not just detected.
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'error', errorReason: 'stalled' }, FIXED);
    h.defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' };
    const engine = makeEngine();
    engine.resume(h.repo);
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    expect(readAppLoopState(h.repo)?.status).toBe('error'); // still not fabricated complete
    expect(engine.liveErrorFor(h.repo)?.kind).toBe('def-unresolvable'); // structured kind, not a message-token match — wording is free to change
    expect(h.emitError).toHaveBeenCalledWith(engine.liveErrorFor(h.repo)?.reason); // the surfaced push equals the live reason, whatever its wording
  });

  it('never re-runs a completed turn on resume', () => {
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'complete' }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    expect(h.injected).toEqual([]);
    expect(readAppLoopState(h.repo)?.status).toBe('complete');
  });

  it('§27.10 — reconstructs a work turn re-carrying the inputs its entry recorded so Retry re-injects them; resume records no chained transition', () => {
    const inputRel = '.agent-terminal/loop/artifacts/groomed-ticket.md';
    const inputPath = seedInputArtifact(join(h.repo, '.agent-terminal', 'loop', 'artifacts', 'groomed-ticket.md'));
    h.defResult = resolved({ ...fileDef(), inputs: [binding('groomed-ticket', inputPath)] });
    // The entry that stopped mid-flight recorded what it carried; resume honours that record, never the disk.
    writeAppLoopState(
      h.repo,
      { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'working', chainedInputs: ['groomed-ticket'] },
      FIXED,
    );
    const engine = makeEngine();
    engine.resume(h.repo);
    expect(h.injected).toEqual([]); // a relaunch-interrupted turn is never re-driven on resume
    expect(h.audit.mock.calls.some((c) => /chained transition/i.test(c[1]))).toBe(false); // resume is not a chain advance
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry'); // the operator re-drives the reconstructed turn
    engine.onInjectable();
    engine.onInjectable();
    const prompt = h.injected.find((p) => p.includes('Produce the plan.'));
    expect(prompt).toBeDefined();
    expect(prompt).toContain(`- groomed-ticket: ${inputRel}`); // the reconstructed turn carried the present input
  });
});

describe('§27.10 — the entry\'s carry is durable across every path that re-enters or reconstructs the step', () => {
  const INPUT_REL = '.agent-terminal/loop/artifacts/groomed-ticket.md';
  const REDO_INSTRUCTION = 'Redo the plan.';

  it('writes the carry into the run state on every phase of the step, not only the work phase', () => {
    bindSeededInput(h.repo);
    const engine = makeEngine();
    enterAndInjectWork(engine, 'chain-advance');
    driveFromWorkToGate(engine); // the review and consolidate phases persist over the same file
    expect(readAppLoopState(h.repo)?.chainedInputs).toEqual(['groomed-ticket']);
  });

  it('re-injects the recorded carry when a redo arrives after a relaunch (a NEW engine, carry only on disk)', () => {
    bindSeededInput(h.repo);
    const engine = makeEngine();
    enterAndInjectWork(engine, 'chain-advance');
    driveFromWorkToGate(engine);
    const relaunched = makeEngine(); // no in-memory carry — the record on disk is the only source
    relaunched.resume(h.repo);
    const before = h.injected.length;
    expect(relaunched.redo(h.repo, STEP, CONSOLIDATE_KEY, REDO_INSTRUCTION)).toBe(true);
    relaunched.onInjectable();
    relaunched.onInjectable();
    const prompt = h.injected.slice(before).find((p) => p.includes('Produce the plan.'));
    expect(prompt).toContain(`- groomed-ticket: ${INPUT_REL}`);
  });

  it('names the recorded carry in a review turn retried after a relaunch (a NEW engine, carry only on disk)', () => {
    bindSeededInput(h.repo);
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'error', errorReason: 'malformed', round: 1, chainedInputs: ['groomed-ticket'] }, FIXED);
    const relaunched = makeEngine();
    relaunched.resume(h.repo);
    relaunched.routeOut(h.repo, STEP, REVIEW_KEY, 'retry');
    relaunched.onInjectable();
    relaunched.onInjectable();
    const prompt = h.injected[h.injected.length - 1];
    expect(prompt).toContain('review-and-fix');
    expect(prompt).toContain(`- groomed-ticket: ${INPUT_REL}`);
    expect(readAppLoopState(h.repo)?.chainedInputs).toEqual(['groomed-ticket']);
  });

  it('keeps the recorded carry in the run state when a resumed turn is retried (a relaunch must not erase it)', () => {
    bindSeededInput(h.repo);
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'working', chainedInputs: ['groomed-ticket'] }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry'); // the first persist after a relaunch rewrites the document
    expect(readAppLoopState(h.repo)?.chainedInputs).toEqual(['groomed-ticket']);
  });

  it('does NOT acquire chained material on a RE-ENTRY of a step whose entry refused to carry it', () => {
    // A fresh run deliberately carried nothing. Re-entering that step (flow.provideInput) must honour the
    // entry's decision, not re-probe the disk and pick the leftover artifact back up.
    bindSeededInput(h.repo);
    const engine = makeEngine();
    enterAndInjectWork(engine, 'fresh-run');
    engine.onStall(); // the turn leaves flight, so the step can be re-entered
    const before = h.injected.length;
    engine.enter(h.repo, 'plan-loop', STEP, 're-entry');
    engine.onInjectable();
    engine.onInjectable();
    const prompt = h.injected.slice(before).find((p) => p.includes('Produce the plan.'));
    expect(prompt).toBeDefined();
    expect(prompt).not.toContain(INPUT_REL);
  });

  it('does not let one step\'s recorded carry govern a DIFFERENT step re-entered from disk', () => {
    // run-state.yaml is one document per repo, overwritten by each step's entry. After the flow advanced to a
    // later step, an undo back here re-enters with no live record — reading that document's carry without
    // checking whose step it describes hands this step the NEXT step's material.
    bindSeededInput(h.repo);
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: 'implement', turnKey: 'work-implement', status: 'working', chainedInputs: ['groomed-ticket'] }, FIXED);
    const engine = makeEngine(); // fresh: nothing live, so the disk is the only source
    const before = h.injected.length;
    engine.enter(h.repo, 'plan-loop', STEP, 're-entry');
    engine.onInjectable();
    const prompt = h.injected.slice(before).find((p) => p.includes('Produce the plan.'));
    expect(prompt).toBeDefined();
    expect(prompt).not.toContain(INPUT_REL);
  });

  it('does not let one repo\'s carry govern another repo\'s step of the same name', () => {
    // One engine serves every open repo, and the shipped flow gives every repo the same step ids — so a carry
    // decided in repo B must not be adopted by repo A's redo, nor written into repo A's run state.
    const repoB = mkdtempSync(join(tmpdir(), 'appengine-b-'));
    try {
      bindSeededInput(h.repo); // repo A has a leftover artifact on disk, but its gate recorded NO carry
      writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: CONSOLIDATE_KEY, status: 'complete', verdict: 'clean' }, FIXED);
      const engine = makeEngine();
      bindSeededInput(repoB);
      engine.enter(repoB, 'plan-loop', STEP, 'chain-advance'); // repo B establishes a carry for step `plan`
      engine.onStall();
      bindSeededInput(h.repo);
      const before = h.injected.length;
      expect(engine.redo(h.repo, STEP, CONSOLIDATE_KEY, REDO_INSTRUCTION)).toBe(true);
      engine.onInjectable();
      engine.onInjectable();
      const prompt = h.injected.slice(before).find((p) => p.includes('Produce the plan.'));
      expect(prompt).toBeDefined();
      expect(prompt).not.toContain(INPUT_REL); // repo A's step carried nothing and still carries nothing
      expect(readAppLoopState(h.repo)?.chainedInputs).toBeUndefined();
    } finally {
      rmSync(repoB, { recursive: true, force: true });
    }
  });

  it('raises no operator alarm from a reconstruction the operator did not ask to run', () => {
    // resume() runs on EVERY route-out — including Terminate — and never re-drives the turn. An unreadable
    // input there is not what the operator's action is about, and re-raising it on every route-out teaches
    // them to dismiss the one channel a real stall depends on to summon a human.
    const iPath = join(h.repo, '.agent-terminal', 'loop', 'artifacts', 'groomed-ticket.md');
    mkdirSync(iPath, { recursive: true }); // a directory where the artifact belongs
    h.defResult = resolved({ ...fileDef(), inputs: [binding('groomed-ticket', iPath)] });
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'working', chainedInputs: ['groomed-ticket'] }, FIXED);
    const engine = makeEngine();
    h.emitError.mockClear();
    engine.resume(h.repo);
    expect(h.emitError).not.toHaveBeenCalledWith(expect.stringContaining('groomed-ticket'));
  });

  it('says so when the artifact a recorded carry id names has vanished since the entry carried it', () => {
    // Absent at a chain advance is normal (no upstream produced it) and stays silent. Absent for an id this
    // step's entry ALREADY carried is a broken chain — the operator's material is gone and the re-entered turn
    // would run without it, which is the same loss the unbound branch refuses to swallow.
    const p = bindSeededInput(h.repo);
    const engine = makeEngine();
    enterAndInjectWork(engine, 'chain-advance');
    driveFromWorkToGate(engine);
    rmSync(p, { force: true }); // the artifacts subtree is uncommitted — a clean or a stray move removes it
    h.emitError.mockClear();
    expect(engine.redo(h.repo, STEP, CONSOLIDATE_KEY, REDO_INSTRUCTION)).toBe(true);
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('groomed-ticket'));
  });

  it('says so when a RETRIED turn can no longer get the input its entry recorded', () => {
    // The route-out handler always resumes before it routes, so the reconstruct is silent by design — but the
    // operator clicking Retry is asking this turn to RUN. Resolving once at reconstruct time and re-injecting
    // from that stale result drops a vanished input from the INPUTS block with nothing said.
    const p = bindSeededInput(h.repo);
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'working', chainedInputs: ['groomed-ticket'] }, FIXED);
    rmSync(p, { force: true });
    const engine = makeEngine();
    engine.resume(h.repo);
    h.emitError.mockClear();
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('groomed-ticket'));
  });

  it('names every input a re-entered turn lost in ONE message, not one dialog that replaces another', () => {
    // Two emitError calls in one resolution render twice into the same dialog host and the second rebuilds
    // over the first, so the operator never sees the input the earlier one named — it is dropped from the
    // INPUTS block, the turn runs anyway, and the recorded path writes no audit event to find it in.
    const ticket = seedInputArtifact(join(h.repo, '.agent-terminal', 'loop', 'artifacts', 'groomed-ticket.md'));
    const notes = seedInputArtifact(join(h.repo, '.agent-terminal', 'loop', 'artifacts', 'design-notes.md'), '# notes\n');
    h.defResult = resolved({ ...fileDef(), inputs: [binding('groomed-ticket', ticket), binding('design-notes', notes)] });
    const engine = makeEngine();
    enterAndInjectWork(engine, 'chain-advance'); // both present → both recorded
    driveFromWorkToGate(engine);
    rmSync(ticket, { force: true }); // one vanishes -> not-produced
    rmSync(notes, { force: true });
    mkdirSync(notes, { recursive: true }); // the other becomes unreadable
    h.emitError.mockClear();
    expect(engine.redo(h.repo, STEP, CONSOLIDATE_KEY, REDO_INSTRUCTION)).toBe(true);
    expect(h.emitError).toHaveBeenCalledTimes(1);
    expect(h.emitError.mock.calls[0][0]).toContain('groomed-ticket');
    expect(h.emitError.mock.calls[0][0]).toContain('design-notes');
  });

  it('says so when a recorded input vanished before the review round is injected', () => {
    const p = bindSeededInput(h.repo);
    const engine = makeEngine();
    enterAndInjectWork(engine, 'chain-advance');
    writeArtifact(true);
    rmSync(p, { force: true });
    h.emitError.mockClear();
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected[h.injected.length - 1]).toContain('review-and-fix');
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('groomed-ticket'));
  });

  it('says so when a recorded input is unreadable when the review round is injected', () => {
    const p = bindSeededInput(h.repo);
    const engine = makeEngine();
    enterAndInjectWork(engine, 'chain-advance');
    writeArtifact(true);
    rmSync(p, { force: true });
    mkdirSync(p, { recursive: true });
    h.emitError.mockClear();
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
    expect(h.emitError).toHaveBeenCalledWith(expect.stringMatching(/unreadable.*groomed-ticket/));
  });

  it('says so when a RETRIED review turn can no longer get the input its entry recorded, but not on the resume itself', () => {
    const p = bindSeededInput(h.repo);
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'error', errorReason: 'malformed', round: 1, chainedInputs: ['groomed-ticket'] }, FIXED);
    rmSync(p, { force: true });
    const engine = makeEngine();
    h.emitError.mockClear();
    engine.resume(h.repo);
    expect(h.emitError).not.toHaveBeenCalledWith(expect.stringContaining('groomed-ticket'));
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'retry');
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('groomed-ticket'));
  });

  it('announces nothing when a reconstruction finds a recorded input has vanished', () => {
    // The reconstruct scope must stay silent for BOTH unresolved states, not just the unreadable one:
    // resume runs on every route-out, including the Terminate that abandons the flow.
    const p = bindSeededInput(h.repo);
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'working', chainedInputs: ['groomed-ticket'] }, FIXED);
    rmSync(p, { force: true }); // absent, not a directory — the not-produced leg of the stranded list
    const engine = makeEngine();
    h.emitError.mockClear();
    engine.resume(h.repo);
    expect(h.emitError).not.toHaveBeenCalledWith(expect.stringContaining('groomed-ticket'));
  });

  it('drops an input from the RETRIED prompt when it vanished after the turn was reconstructed', () => {
    const p = bindSeededInput(h.repo);
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'working', chainedInputs: ['groomed-ticket'] }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo); // present here — the reconstruction carried it
    rmSync(p, { force: true }); // gone by the time the operator clicks Retry
    const before = h.injected.length;
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    const prompt = h.injected.slice(before).find((pr) => pr.includes('Produce the plan.'));
    expect(prompt).toBeDefined();
    expect(prompt).not.toContain(INPUT_REL); // never announce material the turn cannot read
  });

  it('carries an input into the RETRIED prompt when it was restored after the turn was reconstructed', () => {
    const target = join(h.repo, '.agent-terminal', 'loop', 'artifacts', 'groomed-ticket.md');
    bindSeededInput(h.repo);
    rmSync(target, { force: true }); // absent at reconstruct
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'working', chainedInputs: ['groomed-ticket'] }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    seedInputArtifact(target); // the operator restores it, then retries
    const before = h.injected.length;
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    const prompt = h.injected.slice(before).find((pr) => pr.includes('Produce the plan.'));
    expect(prompt).toContain(`- groomed-ticket: ${INPUT_REL}`);
  });

  it('grades a retried turn against the SAME def revision its prompt was composed from', () => {
    // The natural repair loop after a turn-error is: edit the def, press Retry. Refreshing only the inputs
    // would inject the new revision's INPUTS block beside the old revision's recipe and completion contract,
    // so the agent writes where the prompt says while the gate reads somewhere else — and no number of
    // retries ever picks the edit up.
    bindSeededInput(h.repo);
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'working', chainedInputs: ['groomed-ticket'] }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    const edited = 'sentinel/edited-def/plan.md'; // the operator's edit moves the completion artifact
    h.defResult = resolved({ ...fileDef(), outputs: [{ id: 'plan', path: h.artifactPath, rel: edited }] });
    const before = h.injected.length;
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    const prompt = h.injected.slice(before).find((pr) => pr.includes('Produce the plan.'));
    expect(prompt).toContain(edited); // the completion contract came from the same resolution as the inputs
  });

  it('refuses a retry whose def no longer resolves rather than re-running on a stale contract', () => {
    bindSeededInput(h.repo);
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'working', chainedInputs: ['groomed-ticket'] }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    h.defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' };
    const before = h.injected.length;
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    expect(h.injected.length).toBe(before); // nothing re-injected
    expect(engine.liveErrorFor(h.repo)?.kind).toBe('def-unresolvable'); // and the operator keeps a route out
  });

  it('refuses a REVIEW retry whose def no longer resolves, and a later retry still carries the operator feedback', () => {
    const FEEDBACK = 'Tighten the error-path coverage.';
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'error', errorReason: 'malformed', round: 2, feedback: FEEDBACK }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    const good = h.defResult;
    h.defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' };
    const before = h.injected.length;
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected.length).toBe(before);
    expect(engine.liveErrorFor(h.repo)?.kind).toBe('def-unresolvable');
    h.defResult = good;
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected[h.injected.length - 1]).toContain('review-and-fix');
    expect(h.injected[h.injected.length - 1]).toContain(FEEDBACK);
  });

  it('refuses Accept after a retry-refuse leaves a commits turn on an unresolvable def (CWE-754)', () => {
    // Retry's def-unresolvable refuse returned without touching `active`, so a commits turn kept
    // `completion: { kind: 'commits' }` — whose completionSatisfied() is unconditionally true. The very next
    // Accept then fabricated `complete` on a def that no longer resolves. Retry and Accept must agree on the
    // def-resolves precondition, exactly as the resume path neutralizes it (completion → unresolved).
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'error', errorReason: 'stalled' }, FIXED);
    h.defResult = resolved(commitDef()); // resolves at resume — the commits turn is routable
    const engine = makeEngine();
    engine.resume(h.repo);
    h.defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' }; // operator edits the def unresolvable
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry'); // refuses (def-unresolvable), disk stays error
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept'); // must NOT finalize on the stale commits contract
    expect(readAppLoopState(h.repo)?.status).toBe('error'); // not fabricated complete
    expect(engine.liveErrorFor(h.repo)?.kind).toBe('def-unresolvable'); // and a route out remains
  });

  it('refuses Accept after a retry-refuse even when a well-formed artifact is present (CWE-754, file parity)', () => {
    // The commits sibling proves neutralization overrides an unconditionally-true completion; this proves it
    // also overrides a genuinely SATISFIABLE one — a present, well-formed file — so an unresolvable def can
    // never be finalized on a real artifact it no longer describes. This is the other half of the parity the
    // retry-refuse comment claims, pinned independently.
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'error', errorReason: 'stalled' }, FIXED);
    h.defResult = resolved(fileDef()); // a file-completion turn, resolvable at resume
    const engine = makeEngine();
    engine.resume(h.repo);
    writeArtifact(true); // present and well-formed — completionSatisfied() would otherwise be true
    h.defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' }; // operator edits the def unresolvable
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry'); // refuses (def-unresolvable)
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept'); // must NOT finalize on the present artifact
    expect(readAppLoopState(h.repo)?.status).toBe('error'); // not fabricated complete
    expect(engine.liveErrorFor(h.repo)?.kind).toBe('def-unresolvable');
  });

  it('says so when a recorded carry id no longer matches any binding the def declares', () => {
    // The def is re-resolved on every reconstruct path, so an edit that renames an input binding strands the
    // material the entry recorded. Dropping it silently is the swallowed-failure the standards forbid.
    bindSeededInput(h.repo);
    const engine = makeEngine();
    enterAndInjectWork(engine, 'chain-advance');
    driveFromWorkToGate(engine);
    const renamed = seedInputArtifact(join(h.repo, '.agent-terminal', 'loop', 'artifacts', 'groomed-ticket-v2.md'));
    h.defResult = resolved({ ...fileDef(), inputs: [binding('groomed-ticket-v2', renamed)] });
    h.emitError.mockClear();
    expect(engine.redo(h.repo, STEP, CONSOLIDATE_KEY, REDO_INSTRUCTION)).toBe(true);
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('groomed-ticket'));
  });
});

describe('§27 engine — the review-and-fix turn (AC3, AC4, AC5, AC7)', () => {
  it('completes only on the done-file + a well-formed report at the round-keyed location, then chains the consolidator (AC1, AC3)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    const afterReviewPrompt = h.injected.length;
    engine.onDoneSignal(); // done-signal but NO report yet → not well-formed → one retry
    expect(readAppLoopState(h.repo)?.status).not.toBe('complete');
    expect(h.injected.length).toBe(afterReviewPrompt + 1); // re-injected once
    writeReport(); // a well-formed report accounting for the full roster, at reports/1.md
    expect(existsSync(roundReportFile(h.repo, 1)!)).toBe(true);
    engine.onDoneSignal(); // done-signal + well-formed report → the review round completes and chains the consolidator (§27.6/N4)
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'working', round: 1 });
  });

  it('a report OMITTING a roster persona is malformed → one re-injection then error (AC4)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    const afterReviewPrompt = h.injected.length;
    writeReport(exampleRoundReport({ sections: ['summary'], roster: [ROSTER[0]] })); // omits ROSTER[1]
    engine.onDoneSignal(); // first malformed → re-inject
    expect(h.injected.length).toBe(afterReviewPrompt + 1);
    expect(readAppLoopState(h.repo)?.status).not.toBe('error');
    engine.onDoneSignal(); // second malformed → error
    const state = readAppLoopState(h.repo);
    expect(state).toMatchObject({ turnKey: REVIEW_KEY, status: 'error', round: 1 });
    expect(state?.errorReason).toBeTruthy();
    expect(h.emitError).toHaveBeenCalled();
    // AC8 — the review-round error is recorded in the §25 audit with its reason (exit 1).
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining(state!.errorReason!), 1);
  });

  it('a report recording a reviewer as not loaded in this agent session stops at once, naming it, without a retry (§27.4)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    const afterReviewPrompt = h.injected.length;
    writeReport(`## summary\n\n### ${ROSTER[0]}\n\n${REPORT_GRAMMAR.emptyMarker}\n\n### ${ROSTER[1]}\n\n${REPORT_GRAMMAR.notLoadedMarker}\n`);
    engine.onDoneSignal();
    expect(h.injected.length).toBe(afterReviewPrompt);
    const state = readAppLoopState(h.repo);
    expect(state).toMatchObject({ turnKey: REVIEW_KEY, status: 'error', round: 1 });
    expect(state?.errorReason).toContain(ROSTER[1]);
    expect(state?.errorReason).toMatch(/restart your agent session/i);
  });

  // §27.12 — the agent can run the same checker the engine gates on before it signals done.
  it('the review prompt hands the agent the checker command for this round\'s report', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    expect(h.injected[h.injected.length - 1]).toContain(`check-artifact report ${roundReportRel(1)} --sections summary --roster ${ROSTER.join(',')}`);
  });

  // §27.4 — the reviewers grade the work turn's artifact, so a groom round never re-reviews the stale issue body.
  it('the review prompt names the work artifact as the reviewers\' subject', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    const prompt = h.injected[h.injected.length - 1];
    expect(prompt).toContain(binding('plan', h.artifactPath).rel);
    expect(prompt).toMatch(/not the issue body/i);
  });

  it('a commit-producing loop\'s review prompt names no artifact subject', () => {
    h.defResult = resolved(commitDef());
    const engine = makeEngine();
    enterAndInjectWork(engine);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
    const prompt = h.injected[h.injected.length - 1];
    expect(prompt).toContain('review-and-fix');
    expect(prompt).not.toMatch(/not the issue body/i);
  });

  // §27.4
  it('a commit-producing loop\'s review prompt names the inputs the step carried, by path', () => {
    const planPath = seedInputArtifact(join(h.repo, '.agent-terminal', 'loop', 'artifacts', 'plan.md'), '# plan\n');
    h.defResult = resolved({ ...commitDef(), inputs: [binding('plan', planPath)] });
    const engine = makeEngine();
    enterAndInjectWork(engine);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
    const prompt = h.injected[h.injected.length - 1];
    expect(prompt).toContain('review-and-fix');
    expect(prompt).toContain('- plan: .agent-terminal/loop/artifacts/plan.md');
  });

  // §27.12 — a present-but-malformed report is repaired, not re-reviewed: the retry names each problem and
  // asks for the report alone, so the reviewers do not run a second time.
  it('a malformed report is retried as a report repair naming each problem, not a re-review', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    const firstPrompt = h.injected[h.injected.length - 1];
    writeReport(exampleRoundReport({ sections: ['summary'], roster: [ROSTER[0]] })); // omits ROSTER[1]
    engine.onDoneSignal();
    const retry = h.injected[h.injected.length - 1];
    expect(retry).not.toBe(firstPrompt);
    expect(retry).toContain(`### ${ROSTER[1]}`);
    expect(retry).toContain(roundReportRel(1));
    expect(retry.toLowerCase()).toContain('do not re-run the reviewers');
    expect(retry).not.toContain('Spawn each reviewer');
    expect(retry).toContain(`check-artifact report ${roundReportRel(1)}`);
    expect(retry).toContain(REVIEW_KEY);
  });

  it('a repaired report completes the round on the retry', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    writeReport(exampleRoundReport({ sections: ['summary'], roster: [ROSTER[0]] }));
    engine.onDoneSignal();
    writeReport();
    engine.onDoneSignal();
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'working', round: 1 });
  });

  it('a MISSING report is retried as the full review round (nothing to repair)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    engine.onDoneSignal();
    expect(h.injected[h.injected.length - 1]).toContain('Spawn each reviewer');
  });

  it('the error names the round report as present-but-malformed, never as missing', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    writeReport(exampleRoundReport({ sections: ['summary'], roster: [ROSTER[0]] }));
    engine.onDoneSignal();
    engine.onDoneSignal();
    const reason = readAppLoopState(h.repo)?.errorReason ?? '';
    expect(reason).toContain(roundReportRel(1));
    expect(reason).toContain('not well-formed');
    expect(reason).not.toContain('missing');
    expect(h.emitError).toHaveBeenCalledWith(reason);
  });

  it('the error names the round report as missing when none was written', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    engine.onDoneSignal();
    engine.onDoneSignal();
    const reason = readAppLoopState(h.repo)?.errorReason ?? '';
    expect(reason).toContain(roundReportRel(1));
    expect(reason).toContain('missing');
  });

  it('a report that does not parse against the declared structure is malformed → error (AC4)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    writeReport('nonsense with no sections and no persona records\n'); // missing the `summary` section
    engine.onDoneSignal();
    engine.onDoneSignal();
    expect(readAppLoopState(h.repo)?.status).toBe('error');
  });

  it('a report accounting for a persona that recorded nothing (empty marker) still completes the round and chains the consolidator (AC5)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    // exampleRoundReport gives ROSTER[1] only the empty marker — a present-empty persona. The round completes.
    writeReport();
    engine.onDoneSignal();
    expect(readAppLoopState(h.repo)?.turnKey).toBe(CONSOLIDATE_KEY); // review complete → consolidator chains
  });

  it('audits the review-round boundary and completion with the review-round vocabulary (§25 wiring, AC3)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine); // work complete → cross the pre-review boundary → inject the review prompt
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('review round 1 boundary'), null);
    writeReport();
    engine.onDoneSignal();
    // The review round completes (audited) and chains the consolidator (§27.6/N4) rather than halting.
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('review round 1 complete'), 0);
    expect(readAppLoopState(h.repo)?.turnKey).toBe(CONSOLIDATE_KEY);
  });

  it('audits a review-round error and retry with the review-round vocabulary, never the work-turn string (§25 wiring, AC4/AC8)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    writeReport(exampleRoundReport({ sections: ['summary'], roster: [ROSTER[0]] })); // omits ROSTER[1] → malformed
    engine.onDoneSignal();
    engine.onDoneSignal(); // → review error
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('review round 1 failed'), 1);
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'retry');
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('review round 1 retry'), null);
  });

  it('the report is never read for a review turn whose report location cannot be resolved → cannot complete', () => {
    const engine = makeEngine();
    // resolveReportLocation returns null (e.g. a planted symlink at the loop area): the review turn errors
    // rather than fabricating a pass on an unreadable report.
    h.deps.resolveReportLocation = () => null;
    enterAndInjectWork(engine);
    writeArtifact(true);
    engine.onDoneSignal(); // work completes → chain review, but the location is unresolvable
    expect(readAppLoopState(h.repo)?.status).toBe('error');
    expect(readAppLoopState(h.repo)?.turnKey).toBe(REVIEW_KEY);
  });
});

describe('§27 engine — the review-and-fix route-out diverges from the work accept (AC8)', () => {
  function toReviewError(engine: ReturnType<typeof createAppLoopEngine>): void {
    driveToReviewInjected(engine);
    writeReport(exampleRoundReport({ sections: ['summary'], roster: [ROSTER[0]] })); // omits ROSTER[1]
    engine.onDoneSignal();
    engine.onDoneSignal(); // → review error
  }

  it('accept OVERRIDES the gate: advances with the malformed report kept, WITHOUT re-running or injecting (AC8)', () => {
    const engine = makeEngine();
    toReviewError(engine);
    const malformed = readFileSync(roundReportFile(h.repo, 1)!, 'utf8');
    const afterError = h.injected.length;
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'complete', round: 1 });
    expect(h.injected.length).toBe(afterError); // never re-injected — the malformed report was NOT re-generated
    expect(readFileSync(roundReportFile(h.repo, 1)!, 'utf8')).toBe(malformed); // the report is kept, malformation included
    // AC8 — the override is recorded in the §25 audit with the review-round vocabulary (§25 wiring): a bare
    // `accept` substring is vacuous here (the work-turn accept literal also carries it), so pin `review round N`.
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('review round 1 accepted'), 0);
  });

  it('accept does NOT require a well-formed report (the override diverges from the work turn\'s artifact-gated accept)', () => {
    const engine = makeEngine();
    toReviewError(engine);
    // The report on disk is malformed and stays malformed; accept still advances (the human backstop).
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    expect(readAppLoopState(h.repo)?.status).toBe('complete');
  });

  it('accept REFUSES a review round whose report was NEVER written — present is the one precondition the override keeps (§27.12c/CWE-754)', () => {
    // The fixer wrote its done-file but no report (a real §27.15 "writes nothing" state): retry-then-error with
    // NOTHING on disk. The AC8 override keeps a present-but-MALFORMED report; there is none here, so accept must
    // refuse — finalizing `complete` would record a round with no auditable report at all (§27.5), the exact
    // fabricated-completion the §27.12c "artifact actually present" precondition forbids.
    const engine = makeEngine();
    driveToReviewInjected(engine);
    engine.onDoneSignal(); // no report → one retry
    engine.onDoneSignal(); // still no report → review error, report absent
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'error', round: 1 });
    expect(existsSync(roundReportFile(h.repo, 1)!)).toBe(false);
    const afterError = h.injected.length;
    const emitsBeforeAccept = h.emitError.mock.calls.length;
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    expect(readAppLoopState(h.repo)?.status).toBe('error'); // refused — NOT fabricated complete
    expect(h.injected.length).toBe(afterError); // and never re-injected
    // the accept click itself surfaces a FRESH error emission (not merely the earlier drive-to-error one), so
    // Retry/Terminate stay the route out — a count increment, since the reason prose is free to change and the
    // drive already left a same-kind live error standing (asserting kind/reason alone would be vacuous).
    expect(h.emitError.mock.calls.length).toBeGreaterThan(emitsBeforeAccept);
    expect(engine.liveErrorFor(h.repo)?.kind).toBe('turn-error');
  });

  it('accept REFUSES an UNRESOLVED review round reached via a report-location failure — never fabricates a finalized round (CWE-754/755)', () => {
    // An `unresolved` review turn (the loop area/def no longer resolves) has NO report to keep, so the AC8
    // override has nothing to finalize; accept must refuse it exactly as the work-turn def-unresolvable guard
    // does, not persist `complete` over an empty round. Reached here by chaining review when the report
    // location is unresolvable (startReview's unresolved fallback).
    const engine = makeEngine();
    h.deps.resolveReportLocation = () => null;
    enterAndInjectWork(engine);
    writeArtifact(true);
    engine.onDoneSignal(); // work completes → chain review, but the location is unresolvable → unresolved review error
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'error' });
    const afterError = h.injected.length;
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    expect(readAppLoopState(h.repo)?.status).toBe('error'); // refused — NOT fabricated complete
    expect(h.injected.length).toBe(afterError); // and never re-injected
  });

  it('accept REFUSES an UNRESOLVED review round reconstructed on resume (def deleted) and surfaces def-unresolvable (CWE-755)', () => {
    // The def was deleted/edited between runs; resume reconstructs an `unresolved` review turn. Accepting it
    // would finalize the round `complete` with reportPath === '' and no report — violating AC7 (one immutable
    // report per finalized round) and AC8 (accept keeps THE malformed report; here there is none). The guard
    // must refuse and surface a def-unresolvable reason so Retry/Terminate are the route out.
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'error', errorReason: 'report omits a roster persona', round: 1 }, FIXED);
    h.defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' };
    const engine = makeEngine();
    engine.resume(h.repo);
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    expect(readAppLoopState(h.repo)?.status).toBe('error'); // still not fabricated complete
    expect(engine.liveErrorFor(h.repo)?.kind).toBe('def-unresolvable'); // structured kind — wording free to change
    expect(h.emitError).toHaveBeenCalledWith(engine.liveErrorFor(h.repo)?.reason);
  });

  it('retry re-enters the same review-and-fix turn of the correct round (boundary + review prompt)', () => {
    const engine = makeEngine();
    toReviewError(engine);
    const afterError = h.injected.length;
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'retry');
    engine.onInjectable(); // pre-review boundary drains
    engine.onInjectable(); // review prompt re-injects
    expect(h.injected.length).toBeGreaterThan(afterError);
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'working', round: 1 });
  });

  it('terminate moves the flow off the step', () => {
    const engine = makeEngine();
    toReviewError(engine);
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'terminate');
    expect(h.terminateFlow).toHaveBeenCalledWith(h.repo);
  });
});

describe('§27 engine — review-turn resume (AC9)', () => {
  it('reconstructs a stopped review turn (round + turnKey), never re-drives it, and retry acts on it', () => {
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'error', errorReason: 'report omits a roster persona', round: 1 }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    expect(h.injected).toEqual([]); // human-owned — never re-driven on resume
    expect(engine.liveErrorFor(h.repo)).toMatchObject({ step: STEP, turnKey: REVIEW_KEY });
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'retry'); // acts on the reconstructed review turn of round 1
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'working', round: 1 });
  });

  it('accept on a resumed review error keeps the malformed report and completes without re-running (AC8, AC9)', () => {
    writeReport(exampleRoundReport({ sections: ['summary'], roster: [ROSTER[0]] })); // a malformed report is on disk
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'error', errorReason: 'malformed', round: 1 }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    expect(readAppLoopState(h.repo)?.status).toBe('complete');
    expect(h.injected).toEqual([]); // never injected on the accept override
  });

  it('never re-runs a completed review turn on resume', () => {
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'complete', round: 1 }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    expect(h.injected).toEqual([]);
    expect(readAppLoopState(h.repo)?.status).toBe('complete');
  });
});

describe('§27 engine — the consolidator turn chains after review (AC1)', () => {
  it('crosses the pre-consolidate boundary and injects the consolidator prompt on its own — no human action', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    writeRoundReport(1);
    const afterReview = h.injected.length;
    engine.onDoneSignal(); // review completes → chain the consolidator
    engine.onInjectable(); // pre-consolidate boundary drains
    expect(h.injected[afterReview]).toBe('/compact Keep the two round reports.'); // the def's pre-consolidate boundary
    engine.onInjectable(); // consolidator prompt injects
    expect(h.injected[afterReview + 1]).toContain('consolidator'); // the consolidate recipe/instruction
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'working', round: 1 });
    expect(engine.activeTurnKey()).toBe(CONSOLIDATE_KEY);
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('consolidate'), null);
  });
});

describe('§27 engine — the consolidator completion gate (AC3)', () => {
  it('advances only on the done-file AND a well-formed verdict; malformed output retries once then errors', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    const afterConsolidate = h.injected.length;
    writeConsolidatorOutput(1, 'no verdict here\n'); // malformed: no verdict
    engine.onDoneSignal(); // first malformed → one re-injection
    expect(h.injected.length).toBe(afterConsolidate + 1);
    expect(readAppLoopState(h.repo)?.status).not.toBe('error');
    engine.onDoneSignal(); // second malformed → error
    const state = readAppLoopState(h.repo);
    expect(state).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'error', round: 1 });
    expect(state?.errorReason).toBeTruthy();
    expect(h.emitError).toHaveBeenCalled();
  });

  it('the consolidator prompt hands the agent the checker command for its verdict', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    expect(h.injected[h.injected.length - 1]).toContain(`check-artifact verdict ${consolidatorOutputRel(1)} --catalog ${ROSTER.join(',')}`);
  });

  // §27.12 — a present-but-malformed verdict is repaired, not re-judged: the retry names the problem.
  it('a malformed verdict is retried as a verdict repair naming the problem', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    const firstPrompt = h.injected[h.injected.length - 1];
    writeConsolidatorOutput(1, 'verdict: another round\nroster: ghost-persona\n');
    engine.onDoneSignal();
    const retry = h.injected[h.injected.length - 1];
    expect(retry).not.toBe(firstPrompt);
    expect(retry).toContain('ghost-persona');
    expect(retry).toContain(consolidatorOutputRel(1));
    expect(retry).toContain(`check-artifact verdict ${consolidatorOutputRel(1)}`);
    expect(retry).toContain(CONSOLIDATE_KEY);
  });

  it('an `another round` naming a persona outside the catalog is malformed → error (§27.4)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, 'verdict: another round\nroster: ghost-persona\n');
    completeConsolidate(engine, 1, 'verdict: another round\nroster: ghost-persona\n');
    expect(readAppLoopState(h.repo)?.status).toBe('error');
  });

  it('an `another round` with an empty roster is malformed → error (a round must run someone)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, 'verdict: another round\nroster:\n');
    completeConsolidate(engine, 1, 'verdict: another round\nroster:\n');
    expect(readAppLoopState(h.repo)?.status).toBe('error');
  });

  it('a terminal verdict needs no roster — `clean` completes and routes to the gate (AC3, AC5)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, 'verdict: clean\n');
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'complete', round: 1, verdict: 'clean' });
  });
});

describe('§27 engine — the verdict drives the branch (AC4, AC5, AC6)', () => {
  it('`another round` returns to a review-and-fix round over EXACTLY the chosen roster (AC4)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    const afterConsolidate = h.injected.length;
    completeConsolidate(engine, 1, `verdict: another round\nroster: ${ROSTER[0]}\n`); // subset: principal only
    engine.onInjectable(); // pre-review boundary drains
    engine.onInjectable(); // the round-2 review prompt injects
    const prompt = h.injected[h.injected.length - 1];
    expect(prompt).toContain(ROSTER[0]); // the chosen persona is in the round-2 roster
    expect(prompt).not.toContain(ROSTER[1]); // the un-chosen persona is NOT
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'working', round: 2, chosenRoster: [ROSTER[0]] });
    expect(h.injected.length).toBeGreaterThan(afterConsolidate);
  });

  it('`clean` on a no-change round routes to the gate; the panel-facing state carries the verdict (AC5, AC6)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, 'verdict: clean\n');
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', verdict: 'clean' });
  });

  it('`stop for a human` routes to the gate carrying the consolidator reason (AC5)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, 'verdict: stop for a human\nreason: the reviewers disagree on the API shape\n');
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', verdict: 'stop for a human', verdictReason: 'the reviewers disagree on the API shape' });
  });

  it('the engine routes on the EMITTED verdict and does not recompute cleanness — `another round` on a fixed round loops (AC6)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, `verdict: another round\nroster: ${ROSTER.join(', ')}\n`);
    expect(readAppLoopState(h.repo)?.turnKey).toBe(REVIEW_KEY); // looped back, not gated
  });

  it('a terminal `complete` write that FAILS still summons the human via a live error — never a stale `working` dead-end (CWE-703/755)', () => {
    // The consolidator reaches a terminal verdict, but the `complete` persist throws (ENOSPC/EPERM/a planted
    // symlink at the run-state file). Without the guard the disk holds the pre-terminal `working` and the human
    // is never told to decide (isHumanNeededStatus('working') is false, and no verdict row renders). The engine
    // must hold a LIVE error so deriveAppLoopView surfaces the route-out.
    const engine = makeEngine((repoDir, state) => {
      if (state.status === 'complete') throw new Error('ENOSPC: no space left on device');
      writeAppLoopState(repoDir, state, FIXED);
    });
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, 'verdict: stop for a human\nreason: the reviewers disagree on the API\n');
    expect(engine.liveErrorFor(h.repo)).not.toBeNull(); // the human is summoned even though the write failed
    expect(engine.liveErrorFor(h.repo)).toMatchObject({ kind: 'turn-error', step: STEP, turnKey: CONSOLIDATE_KEY });
    expect(h.emitError).toHaveBeenCalled(); // pushed so the panel renders the retry/terminate route-out
  });

  it('a finish-time output read that vanishes AFTER the gate accepted it falls back to `stop for a human` — never a silent `clean` (§27.6 race)', () => {
    // The completion gate reads the output as well-formed (`clean`), then a race (truncation, an unlink, a
    // planted-symlink swap) makes the finish re-read return null. finishConsolidate must fall to the SAFE side —
    // route to the gate as `stop for a human`, summoning the human — and MUST NOT advance a silent `clean` round
    // on a verdict it can no longer read.
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    writeConsolidatorOutput(1, 'verdict: clean\n');
    h.readArtifact.mockImplementationOnce(() => 'verdict: clean\n').mockImplementationOnce(() => null);
    engine.onDoneSignal();
    const state = readAppLoopState(h.repo);
    expect(state).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'complete', verdict: 'stop for a human' });
    expect(state?.verdict).not.toBe('clean');
  });

  it('there is no iteration cap — a run that keeps emitting `another round` keeps iterating (AC10)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, `verdict: another round\nroster: ${ROSTER.join(', ')}\n`);
    advanceReviewToConsolidateInjected(engine, 2);
    completeConsolidate(engine, 2, `verdict: another round\nroster: ${ROSTER.join(', ')}\n`);
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: REVIEW_KEY, round: 3 }); // round 3, still no cap
  });
});

describe('§27 engine — request-changes returns to a review-and-fix round carrying the feedback (§27.9 / AC4)', () => {
  const FEEDBACK = 'Tighten the migration section; it overspecifies the schema.';

  /** Drive work → review round 1 → consolidator → a terminal `clean` gate (status complete, round 1, verdict). */
  function driveToGate(engine: ReturnType<typeof createAppLoopEngine>): void {
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, 'verdict: clean\n');
  }

  it('re-enters review at round+1 carrying the feedback, and persists it on the review run-state', () => {
    const engine = makeEngine();
    driveToGate(engine);
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', round: 1, verdict: 'clean' });
    const afterGate = h.injected.length;
    engine.requestChanges(h.repo, STEP, CONSOLIDATE_KEY, FEEDBACK);
    engine.onInjectable(); // the pre-review boundary drains
    engine.onInjectable(); // the round-2 review prompt injects
    const prompt = h.injected[h.injected.length - 1];
    expect(h.injected.length).toBeGreaterThan(afterGate);
    expect(prompt).toContain(FEEDBACK); // the feedback rides the next review round (§27.9)
    expect(prompt).toContain(ROSTER[0]); // …alongside the reviewers' findings (full catalog: fresh eyes)
    expect(prompt).toContain(ROSTER[1]);
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'working', round: 2, feedback: FEEDBACK });
  });

  it('runs no consolidator and no work turn — it is the narrow, incremental lever (§27.9)', () => {
    const engine = makeEngine();
    driveToGate(engine);
    engine.requestChanges(h.repo, STEP, CONSOLIDATE_KEY, FEEDBACK);
    engine.onInjectable();
    engine.onInjectable();
    const prompt = h.injected[h.injected.length - 1];
    expect(prompt).toContain('review-and-fix'); // it is a review round…
    expect(prompt).not.toContain('Produce the plan'); // …never the work turn (§27.9 redo is a separate lever)
  });

  it('is inert for a decision naming a different step (§6/AC7)', () => {
    const engine = makeEngine();
    driveToGate(engine);
    const before = h.injected.length;
    engine.requestChanges(h.repo, 'implement', CONSOLIDATE_KEY, FEEDBACK);
    expect(h.injected.length).toBe(before);
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', round: 1 }); // unchanged, still at the gate
  });

  it('is inert when the run is not AT a gate (no verdict reached)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine); // an in-flight review turn — status working, no verdict
    const before = h.injected.length;
    engine.requestChanges(h.repo, STEP, REVIEW_KEY, FEEDBACK);
    expect(h.injected.length).toBe(before);
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'working' });
  });

  it('a Retry after a relaunch re-injects the persisted feedback rather than dropping the human input', () => {
    const engine = makeEngine();
    driveToGate(engine);
    engine.requestChanges(h.repo, STEP, CONSOLIDATE_KEY, FEEDBACK);
    engine.onInjectable();
    engine.onInjectable(); // round-2 review prompt injected; run-state persisted with feedback
    // Simulate a relaunch: a fresh engine reconstructs the stopped review turn from disk, then Retry.
    const relaunched = makeEngine();
    relaunched.resume(h.repo);
    relaunched.routeOut(h.repo, STEP, REVIEW_KEY, 'retry');
    relaunched.onInjectable();
    relaunched.onInjectable();
    expect(h.injected[h.injected.length - 1]).toContain(FEEDBACK); // the feedback survived the relaunch
  });
});

describe('§27 engine — redo re-enters the work turn on a clean slate carrying only the instruction (§27.9 / AC5)', () => {
  const INSTRUCTION = 'The plan structure is wrong — redo it keeping only the schema section.';

  /** Drive work → review round 1 → consolidator → a terminal `clean` gate (status complete, round 1, verdict). */
  function driveToGate(engine: ReturnType<typeof createAppLoopEngine>): void {
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, 'verdict: clean\n');
  }

  it('re-enters the WORK turn carrying the instruction, and persists it on the work run-state', () => {
    const engine = makeEngine();
    driveToGate(engine);
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', round: 1, verdict: 'clean' });
    const before = h.injected.length;
    expect(engine.redo(h.repo, STEP, CONSOLIDATE_KEY, INSTRUCTION)).toBe(true);
    // Drain the boundary + work injection (the runner's settle state is path-dependent, so drain generously
    // and read the re-injected prompt out of the batch rather than a fixed index).
    engine.onInjectable();
    engine.onInjectable();
    const since = h.injected.slice(before);
    expect(since).toContain('/clear'); // re-enters after the def's pre-work boundary (clean slate)
    const prompt = since.find((p) => p.includes('Produce the plan.')); // the work recipe (ticket + plan)
    expect(prompt).toBeDefined();
    expect(prompt).toContain(INSTRUCTION); // the operator's instruction rides along
    expect(since.some((p) => p.includes(ROSTER[0]))).toBe(false); // NO reviewers/findings — no round history
    expect(since.some((p) => p.includes('review-and-fix'))).toBe(false);
    // the work turn is active again, carrying the instruction and NO round/feedback (a fresh work run)
    const state = readAppLoopState(h.repo);
    expect(state).toMatchObject({ turnKey: TURN_KEY, status: 'working', instruction: INSTRUCTION });
    expect(state?.round).toBeUndefined();
    expect(state?.feedback).toBeUndefined();
  });

  it('is the ONLY lever that re-runs the work turn — request-changes never does (§27.9)', () => {
    const engine = makeEngine();
    driveToGate(engine);
    const before = h.injected.length;
    engine.redo(h.repo, STEP, CONSOLIDATE_KEY, INSTRUCTION);
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected.slice(before).some((p) => p.includes('Produce the plan.'))).toBe(true); // the work recipe re-ran
  });

  it('reports true only when it re-entered; inert cases (identity, at-gate) report false so the composer holds open', () => {
    const engine = makeEngine();
    driveToGate(engine);
    const before = h.injected.length;
    // a decision naming a different step (§6/AC7) is inert and reports false
    expect(engine.redo(h.repo, 'implement', CONSOLIDATE_KEY, INSTRUCTION)).toBe(false);
    expect(h.injected.length).toBe(before);
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', round: 1 }); // unchanged, still at the gate
  });

  it('is inert when the run is not AT a gate (no verdict reached), reporting false', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine); // an in-flight review turn — status working, no verdict
    const before = h.injected.length;
    expect(engine.redo(h.repo, STEP, REVIEW_KEY, INSTRUCTION)).toBe(false);
    expect(h.injected.length).toBe(before);
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'working' });
  });

  it('is inert when the bound def no longer resolves — never a fabricated clean-slate run, reporting false', () => {
    const engine = makeEngine();
    driveToGate(engine);
    // §27.9/AC5 — the clean-slate work turn needs the def's recipe + completion contract; an unresolvable def
    // must be inert (return false, inject nothing, leave the gate intact), never a work run with no real backing.
    h.defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' };
    const before = h.injected.length;
    expect(engine.redo(h.repo, STEP, CONSOLIDATE_KEY, INSTRUCTION)).toBe(false);
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected.length).toBe(before); // nothing injected — no boundary, no work prompt
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', round: 1, verdict: 'clean' }); // still at the gate
  });

  it('a Retry after a relaunch re-injects the persisted instruction rather than dropping the human input', () => {
    const engine = makeEngine();
    driveToGate(engine);
    engine.redo(h.repo, STEP, CONSOLIDATE_KEY, INSTRUCTION); // start persists the instruction on the work run-state
    expect(readAppLoopState(h.repo)?.instruction).toBe(INSTRUCTION);
    // Simulate a relaunch: a fresh engine reconstructs the stopped work turn from disk, then Retry.
    const relaunched = makeEngine();
    relaunched.resume(h.repo);
    relaunched.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    relaunched.onInjectable();
    relaunched.onInjectable();
    expect(h.injected.some((p) => p.includes(INSTRUCTION))).toBe(true); // the instruction survived the relaunch
  });

  it('§27.10 — re-carries the step\'s present inputs but records NO new chained transition (a redo is not a chain advance)', () => {
    const inputRel = '.agent-terminal/loop/artifacts/groomed-ticket.md';
    const inputPath = seedInputArtifact(join(h.repo, '.agent-terminal', 'loop', 'artifacts', 'groomed-ticket.md'));
    h.defResult = resolved({ ...fileDef(), inputs: [binding('groomed-ticket', inputPath)] });
    const engine = makeEngine();
    driveToGate(engine); // enter records ONE chained transition (the input is present)
    const chainAuditsBefore = h.audit.mock.calls.filter((c) => /chained transition/i.test(c[1])).length;
    const before = h.injected.length;
    expect(engine.redo(h.repo, STEP, CONSOLIDATE_KEY, INSTRUCTION)).toBe(true);
    engine.onInjectable();
    engine.onInjectable();
    const prompt = h.injected.slice(before).find((p) => p.includes('Produce the plan.'));
    expect(prompt).toBeDefined();
    expect(prompt).toContain(`- groomed-ticket: ${inputRel}`); // the redo re-carries the present input
    expect(prompt).toContain(INSTRUCTION); // alongside the redo instruction
    const chainAuditsAfter = h.audit.mock.calls.filter((c) => /chained transition/i.test(c[1])).length;
    expect(chainAuditsAfter).toBe(chainAuditsBefore); // the non-advance re-entry records no new transition
  });

  it('§27.10 — a redo does NOT acquire chained material a fresh-run entry refused to carry', () => {
    // The entry decision must survive the lever: a step entered as a fresh run carried nothing, so redo —
    // which is not a chain advance either — must not pick the leftover artifact up off the disk.
    const inputRel = '.agent-terminal/loop/artifacts/groomed-ticket.md';
    const inputPath = seedInputArtifact(join(h.repo, '.agent-terminal', 'loop', 'artifacts', 'groomed-ticket.md'));
    h.defResult = resolved({ ...fileDef(), inputs: [binding('groomed-ticket', inputPath)] });
    const engine = makeEngine();
    enterAndInjectWork(engine, 'fresh-run'); // carries nothing
    driveFromWorkToGate(engine);
    const before = h.injected.length;
    expect(engine.redo(h.repo, STEP, CONSOLIDATE_KEY, INSTRUCTION)).toBe(true);
    engine.onInjectable();
    engine.onInjectable();
    const prompt = h.injected.slice(before).find((p) => p.includes('Produce the plan.'));
    expect(prompt).toBeDefined();
    expect(prompt).not.toContain(inputRel);
  });

  it('§27.10 — a resumed turn re-carries only what its entry carried, not whatever is on disk', () => {
    const inputRel = '.agent-terminal/loop/artifacts/groomed-ticket.md';
    const inputPath = seedInputArtifact(join(h.repo, '.agent-terminal', 'loop', 'artifacts', 'groomed-ticket.md'));
    h.defResult = resolved({ ...fileDef(), inputs: [binding('groomed-ticket', inputPath)] });
    const engine = makeEngine();
    enterAndInjectWork(engine, 'fresh-run'); // carries nothing; the turn persists as `working`
    const relaunched = makeEngine(); // a relaunch reconstructs the stopped turn from disk
    relaunched.resume(h.repo);
    const before = h.injected.length;
    relaunched.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    relaunched.onInjectable();
    relaunched.onInjectable();
    const prompt = h.injected.slice(before).find((p) => p.includes('Produce the plan.'));
    expect(prompt).toBeDefined();
    expect(prompt).not.toContain(inputRel);
  });
});

describe('§27 engine — the polish stand-down suppresses the orchestrator levers (§27.9 / AC6)', () => {
  function driveToGate(engine: ReturnType<typeof createAppLoopEngine>): void {
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, 'verdict: clean\n');
  }

  it('refuses request-changes while polish is active — no review round starts, nothing is injected', () => {
    const engine = makeEngine();
    driveToGate(engine);
    h.polishStep = STEP; // the operator entered polish for this gated step; the app-owned flag is set
    const before = h.injected.length;
    expect(engine.requestChanges(h.repo, STEP, CONSOLIDATE_KEY, 'tighten the schema')).toBe(false);
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected.length).toBe(before); // the orchestrator stood down — no injection during polish
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', round: 1 }); // still at the gate
  });

  it('refuses redo while polish is active — the work turn does not re-run', () => {
    const engine = makeEngine();
    driveToGate(engine);
    h.polishStep = STEP;
    const before = h.injected.length;
    expect(engine.redo(h.repo, STEP, CONSOLIDATE_KEY, 'start over')).toBe(false);
    engine.onInjectable();
    expect(h.injected.length).toBe(before);
  });

  it('the levers work again once the stand-down is cleared (approve ends polish)', () => {
    const engine = makeEngine();
    driveToGate(engine);
    h.polishStep = STEP;
    expect(engine.redo(h.repo, STEP, CONSOLIDATE_KEY, 'start over')).toBe(false); // refused during polish
    h.polishStep = null; // approve cleared the stand-down
    expect(engine.redo(h.repo, STEP, CONSOLIDATE_KEY, 'start over')).toBe(true); // the lever works again
  });

  it('a stand-down for a DIFFERENT step does not suppress this step’s levers (step-scoped, not repo-scoped)', () => {
    const engine = makeEngine();
    driveToGate(engine);
    // A polish stand-down persists for some OTHER step (e.g. entered on an earlier step, never cleared). The
    // engine keys suppression on the decision's step exactly as the view does, so this step's redo still runs.
    h.polishStep = 'some-other-step';
    expect(engine.redo(h.repo, STEP, CONSOLIDATE_KEY, 'start over')).toBe(true);
  });

  it('a fresh work-turn entry clears a stale stand-down — an abandoned polish never resurrects on re-drive', () => {
    const engine = makeEngine();
    // A prior run entered polish for this step but was Terminated (or the approve-time clear failed) rather than
    // approved, so the stand-down file persists. Re-driving the same step must start a clean cycle, not inherit it.
    enterPolish(h.repo, STEP);
    expect(isPolishActiveForStep(h.repo, STEP)).toBe(true);
    engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance');
    expect(isPolishActiveForStep(h.repo, STEP)).toBe(false); // the stale stand-down did not survive the fresh entry
  });

  it('a throwing clearPolish never aborts a fresh entry — the work turn still starts (best-effort cleanup)', () => {
    const engine = makeEngine();
    enterPolish(h.repo, STEP); // a stale stand-down exists…
    h.clearPolishError = 'EISDIR: illegal operation on a directory'; // …and clearing it will throw (polish.yaml is a dir)
    const before = h.injected.length;
    // The stale-polish clear is best-effort — a throw must NOT abort the entry, or the operator is stranded with a
    // committed step whose work turn never starts and cannot restart (re-entry would re-throw the same EISDIR).
    expect(() => engine.enter(h.repo, 'plan-loop', STEP, 'chain-advance')).not.toThrow();
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected.slice(before).some((p) => p.includes('Produce the plan.'))).toBe(true); // the work turn started anyway
    // the failed best-effort clear is recorded, never silently swallowed (§25) — the same discipline the approve
    // path pins for its own clear-polish failure.
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('clear-polish'), 1);
  });
});

describe('§27 engine — a failed reviewer is never read as clean (AC7)', () => {
  it('a FRESH failed lens forces a re-review with that lens, even when the consolidator emits `clean`', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine, [ROSTER[0]]); // round-1 report records principal failed-to-run
    completeConsolidate(engine, 1, 'verdict: clean\n'); // consolidator says clean, but a lens failed
    engine.onInjectable();
    engine.onInjectable();
    // The loop does NOT present the round as clean — it re-reviews with the failed lens in the roster.
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: REVIEW_KEY, round: 2 });
    expect(readAppLoopState(h.repo)?.status).not.toBe('complete');
    expect(h.injected[h.injected.length - 1]).toContain(ROSTER[0]); // the failed lens is re-reviewed
  });

  it('a REPEAT failed lens (failed in the previous report too) stops for a human — bounding auto re-reviews to one', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine, [ROSTER[0]]); // round 1: principal failed
    completeConsolidate(engine, 1, 'verdict: clean\n'); // → forced re-review of principal
    advanceReviewToConsolidateInjected(engine, 2, [ROSTER[0]]); // round 2: principal failed AGAIN
    completeConsolidate(engine, 2, 'verdict: clean\n');
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', verdict: 'stop for a human' });
  });

  it('a FRESH failed lens does NOT override an emitted `stop for a human` — the human-owned stop routes to the gate now (§27.6)', () => {
    // When the consolidator itself emits `stop for a human` (the loop is spinning, or a reviewer raised a
    // needs-a-human issue) AND a different lens freshly fails, the fresh-failure re-review must NOT divert the
    // human-owned stop into another autonomous round — the stop routes to the gate now, and the human decides.
    const engine = makeEngine();
    driveToConsolidateInjected(engine, [ROSTER[0]]); // round-1 report records principal failed-to-run (a fresh failure)
    completeConsolidate(engine, 1, 'verdict: stop for a human\nreason: the reviewers disagree on the API\n');
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', verdict: 'stop for a human' });
    expect(readAppLoopState(h.repo)?.turnKey).toBe(CONSOLIDATE_KEY); // gated, not looped into a round-2 review
  });

  it('a reviewer that RAN and raised a `needs a human` issue is NOT a failed lens — it routes via the verdict, not the guard (AC7)', () => {
    // A `needs a human` disposition is a raised issue, not a failed lens: the consolidator's `clean`/`stop`
    // verdict governs, the engine adds no override. Here the consolidator emits `clean` and it is honored.
    const engine = makeEngine();
    driveToReviewInjected(engine);
    const g = REPORT_GRAMMAR;
    const report =
      `## summary\n\n### ${ROSTER[0]}\n\n- issue: a judgment call\n  disposition: needs a human\n  reason: escalated\n\n### ${ROSTER[1]}\n\n${g.emptyMarker}\n`;
    writeReport(report);
    engine.onDoneSignal(); // review completes → consolidator chains
    engine.onInjectable();
    engine.onInjectable();
    completeConsolidate(engine, 1, 'verdict: clean\n');
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', verdict: 'clean' }); // clean honored, no failed-lens override
  });
});

describe('§27 engine — the armed interrupt routes to the gate at the next consolidate (AC9, AC11)', () => {
  it('an armed interrupt routes to the gate stating the would-be verdict, and is one-shot (cleared)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    armInterrupt(h.repo, STEP); // the operator arms during iteration
    completeConsolidate(engine, 1, `verdict: another round\nroster: ${ROSTER.join(', ')}\n`); // would loop back…
    // …but the armed interrupt routes to the gate instead, surfacing the would-be `another round`.
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', verdict: 'another round' });
    expect(readAppLoopState(h.repo)?.turnKey).toBe(CONSOLIDATE_KEY); // stopped at the consolidator's gate, not a new review turn
    expect(readArmedInterrupt(h.repo)).toBeNull(); // one-shot: cleared when honored
  });

  it('with no interrupt armed the same `another round` loops back (the interrupt is the only thing that diverts it)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, `verdict: another round\nroster: ${ROSTER.join(', ')}\n`);
    expect(readAppLoopState(h.repo)?.turnKey).toBe(REVIEW_KEY); // looped back — no diversion
    // §25/AC9 — a round that reaches the gate on its OWN verdict records NO interrupt-honored event, so a
    // regression emitting the interrupt event unconditionally would be caught here (the emission GATE is
    // pinned, not just the vocabulary distinctness in audit.test.ts).
    expect(h.audit).not.toHaveBeenCalledWith(h.repo, expect.stringContaining('interrupt'), expect.anything());
  });

  it('records a DISTINCT §25 interrupt-honored audit event, not the generic terminal `complete` (§25/AC9)', () => {
    // An honored armed interrupt reaches the gate by honoring a queued interrupt, not by the emitted verdict; the
    // §25 timeline must be able to tell the two apart. A run that reached the gate on its own would-be
    // `another round` would leave only a `complete` — so a distinct interrupt event must be recorded.
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    armInterrupt(h.repo, STEP);
    completeConsolidate(engine, 1, `verdict: another round\nroster: ${ROSTER.join(', ')}\n`);
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('interrupt'), expect.anything());
  });
});

describe('§27 engine — consolidator error route-out + resume (AC11, AC12)', () => {
  function toConsolidateError(engine: ReturnType<typeof createAppLoopEngine>): void {
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, 'garbage, no verdict\n');
    completeConsolidate(engine, 1, 'garbage, no verdict\n'); // retry-then-error
  }

  it('a malformed-output error is routable — retry re-enters the same consolidator turn of the correct round', () => {
    const engine = makeEngine();
    toConsolidateError(engine);
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'error', round: 1 });
    const afterError = h.injected.length;
    engine.routeOut(h.repo, STEP, CONSOLIDATE_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected.length).toBeGreaterThan(afterError);
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'working', round: 1 });
  });

  it('terminate on a consolidator error moves the flow off the step', () => {
    const engine = makeEngine();
    toConsolidateError(engine);
    engine.routeOut(h.repo, STEP, CONSOLIDATE_KEY, 'terminate');
    expect(h.terminateFlow).toHaveBeenCalledWith(h.repo);
  });

  it('accept on a consolidator error moves off the error to the gate WITHOUT re-running (AC12)', () => {
    const engine = makeEngine();
    toConsolidateError(engine);
    const afterError = h.injected.length;
    engine.routeOut(h.repo, STEP, CONSOLIDATE_KEY, 'accept');
    expect(readAppLoopState(h.repo)?.status).toBe('complete');
    expect(h.injected.length).toBe(afterError); // never re-injected
  });

  it('resume reconstructs a stopped consolidator turn (round + turnKey), never re-drives it, and retry acts on it (AC11)', () => {
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: CONSOLIDATE_KEY, status: 'error', errorReason: 'malformed verdict', round: 2 }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    expect(h.injected).toEqual([]); // human-owned — never re-driven
    expect(engine.liveErrorFor(h.repo)).toMatchObject({ step: STEP, turnKey: CONSOLIDATE_KEY });
    engine.routeOut(h.repo, STEP, CONSOLIDATE_KEY, 'retry');
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'working', round: 2 });
  });

  it('never re-runs a completed consolidator turn on resume', () => {
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: CONSOLIDATE_KEY, status: 'complete', round: 1, verdict: 'clean' }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    expect(h.injected).toEqual([]);
    expect(readAppLoopState(h.repo)?.status).toBe('complete');
  });

  it('an interrupt armed before a relaunch is still honored at the next consolidate (AC11)', () => {
    armInterrupt(h.repo, STEP); // armed, then the app is relaunched
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, `verdict: another round\nroster: ${ROSTER.join(', ')}\n`);
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', verdict: 'another round' }); // honored post-relaunch
    expect(readArmedInterrupt(h.repo)).toBeNull();
  });
});

// §27.10/§27.12/CWE-703/755 — a persisted `working` turn is DEFINITIONALLY stopped after a relaunch: its PTY
// is gone and resume never re-drives it. resume must make it routable (a live turn-error → route-out), or the
// human is never summoned and the runner sits idle forever — the exact hand-edit-to-recover strand.
describe('§27 engine — resume routes a stopped (working) turn to the human (CWE-703/755)', () => {
  it('a relaunched WORKING consolidator turn is routable — summons the human, never a silent idle', () => {
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: CONSOLIDATE_KEY, status: 'working', round: 2 }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    expect(h.injected).toEqual([]); // definitionally stopped — never re-driven
    const live = engine.liveErrorFor(h.repo);
    expect(live).toMatchObject({ kind: 'turn-error', step: STEP, turnKey: CONSOLIDATE_KEY, round: 2 });
    engine.routeOut(h.repo, STEP, CONSOLIDATE_KEY, 'retry'); // the route-out is reachable
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected.length).toBeGreaterThan(0);
  });

  it('a relaunched WORKING review turn is routable and carries its round', () => {
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'working', round: 1 }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    expect(h.injected).toEqual([]);
    expect(engine.liveErrorFor(h.repo)).toMatchObject({ kind: 'turn-error', step: STEP, turnKey: REVIEW_KEY, round: 1 });
  });

  it('a relaunched WORKING work turn is routable', () => {
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'working' }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    expect(h.injected).toEqual([]);
    expect(engine.liveErrorFor(h.repo)).toMatchObject({ kind: 'turn-error', step: STEP, turnKey: TURN_KEY });
  });

  it('a relaunched COMPLETE turn is NOT re-surfaced as an error (human-owned gate, no route-out needed)', () => {
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: CONSOLIDATE_KEY, status: 'complete', round: 1, verdict: 'clean' }, FIXED);
    const engine = makeEngine();
    engine.resume(h.repo);
    expect(engine.liveErrorFor(h.repo)).toBeNull();
  });
});

// §27.12/§27.15/CWE-703/755 — the STRAND the iter-5 blocker named: after a relaunch nothing has called
// resume(), so the derived view (what the panel/strip actually render) must itself reconstruct a stopped
// turn before reading the live error. Graded at the DERIVED-VIEW boundary (provideAppLoopView over a REAL
// engine + persisted state), NOT by calling resume()/routeOut() directly — a `working` turn that stayed
// `working` in the view carries no route-out and is human-recoverable only by hand-editing run-state.yaml.
describe('§27 derived view — a relaunch-stranded turn surfaces a route-out (CWE-703/755)', () => {
  const viewCtx = () => ({
    tiers: { operator: null, appBundled: BUNDLED_LOOPS_ROOT, retired: null },
    repoDir: h.repo,
    flow: bundledFlowOf('plan-loop'),
  });

  it('derives a persisted `working` consolidator turn to a routable error over a fresh engine', () => {
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: CONSOLIDATE_KEY, status: 'working', round: 2 }, FIXED);
    const engine = makeEngine(); // fresh — no live turn, nothing has called resume()
    const view = provideAppLoopView(engine, 'plan-loop', viewCtx());
    expect(view.status).toBe('error'); // NOT the stranded `working`
    expect(view.humanNeeded).toBe(true); // the cue + OS notifier fire; the route-out renders
    expect(view.appTurn).toEqual({ step: STEP, turnKey: CONSOLIDATE_KEY });
    expect(view.iteration).toBe(2); // the round rides onto the route-out surface
  });

  it('derives a persisted `working` work turn to a routable error with no round', () => {
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'working' }, FIXED);
    const engine = makeEngine();
    const view = provideAppLoopView(engine, 'plan-loop', viewCtx());
    expect(view.status).toBe('error');
    expect(view.humanNeeded).toBe(true);
    expect(view.appTurn).toEqual({ step: STEP, turnKey: TURN_KEY });
    expect(view.iteration).toBeUndefined();
  });

  it('does NOT flip a genuinely LIVE `working` turn to error (resume is skipped when a turn is active)', () => {
    const engine = makeEngine();
    enterAndInjectWork(engine); // a real in-flight turn for this repo — its PTY is alive, not relaunch-stranded
    const view = provideAppLoopView(engine, 'plan-loop', viewCtx());
    expect(view.status).toBe('working'); // the live turn is mirrored as-is, never spuriously errored
    expect(view.humanNeeded).toBe(false);
    expect(view.appTurn).toEqual({ step: STEP, turnKey: TURN_KEY });
  });

  it('does NOT fabricate an error when no §27 run has ever started (run-less view)', () => {
    const engine = makeEngine(); // fresh engine, no persisted run-state on disk
    const view = provideAppLoopView(engine, 'plan-loop', viewCtx());
    expect(view.status).toBe('not-started');
    expect(view.appTurn).toBeUndefined();
    expect(view.humanNeeded).toBe(false);
  });
});

// §27.12c/CWE-703 — the three Accept branches finalize with persist('complete'); a failed finalize write
// (ENOSPC/EPERM/a planted symlink) must re-surface the live error and NOT record an `accept` the disk never
// saved, mirroring the finishConsolidate write-failure guard.
describe('§27 engine — an accept whose `complete` write fails re-surfaces the error and skips the accept audit', () => {
  const failComplete = (repoDir: string, state: AppLoopRunState): void => {
    if (state.status === 'complete') throw new Error('ENOSPC: no space left on device');
    writeAppLoopState(repoDir, state, FIXED);
  };

  it('a WORK-turn accept whose write fails holds the live error and records no accept', () => {
    const engine = makeEngine(failComplete);
    enterAndInjectWork(engine);
    writeArtifact(true); // a present, marker-bearing artifact — accept-able
    engine.onStall(); // → error
    h.audit.mockClear();
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    expect(engine.liveErrorFor(h.repo)).not.toBeNull(); // route-out still reachable
    expect(h.audit).not.toHaveBeenCalledWith(h.repo, expect.stringContaining('accepted'), expect.anything());
  });

  it('a REVIEW-turn accept whose write fails holds the live error and records no accept', () => {
    writeReport(exampleRoundReport({ sections: ['summary'], roster: [ROSTER[0]] })); // present-but-malformed report
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'error', errorReason: 'malformed', round: 1 }, FIXED);
    const engine = makeEngine(failComplete);
    engine.resume(h.repo);
    h.audit.mockClear();
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    expect(engine.liveErrorFor(h.repo)).not.toBeNull();
    expect(h.audit).not.toHaveBeenCalledWith(h.repo, expect.stringContaining('accept'), expect.anything());
  });

  it('a CONSOLIDATOR accept whose write fails holds the live error and records no accept (AC12)', () => {
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: CONSOLIDATE_KEY, status: 'error', errorReason: 'malformed verdict', round: 1 }, FIXED);
    const engine = makeEngine(failComplete);
    engine.resume(h.repo);
    h.audit.mockClear();
    engine.routeOut(h.repo, STEP, CONSOLIDATE_KEY, 'accept');
    expect(engine.liveErrorFor(h.repo)).not.toBeNull();
    expect(h.audit).not.toHaveBeenCalledWith(h.repo, expect.stringContaining('accept'), expect.anything());
  });
});

describe('§28.5.3 — the RED completion gate (Option C, engine-async)', () => {
  // A RED completion chains the review-and-fix turn, whose prompt names the roster; a failure surfaces emitError.
  const reviewChained = (): boolean => h.injected.some((s) => s.includes(ROSTER[0]));
  const redFake = (overrides: Partial<LoopCompletionPredicates> = {}): LoopCompletionPredicates =>
    makeFakeCompletionPredicates({
      workingTreeTestPaths: async () => ({ ok: true, paths: ['tests/a.test.ts'] }),
      ...overrides,
    });
  const enterRed = (engine: ReturnType<typeof createAppLoopEngine>, def: LoopDefV2 = redDef()): void => {
    h.defResult = resolved(def);
    enterAndInjectWork(engine);
  };

  it('IT-ENGINE-writer: entering a RED-completion def injects a work prompt instructing the phase-result write (§28.5.5 §7d writer wiring)', () => {
    const engine = makeEngine(undefined, redFake());
    enterRed(engine);
    // The compose-site red branch threads the result binding into the injected work prompt; reverting it to
    // `null` composes a plain work prompt with NO result instruction (and the done-signal loses its verify
    // clause) — a real agent would never be told to write the file. This pins that wiring at the injected
    // boundary, mirroring the file case's injected[1] assertions (recipe + marker + done-signal).
    expect(h.injected[1]).toContain('red-result.md'); // the resultRel the engine threaded — the file to write
    expect(h.injected[1]).toContain(PHASE_RESULT_GRAMMAR.capturedOutputHeading); // the grammar the agent must emit
    expect(h.injected[1]).toContain(RED_COMPLETING_OUTCOME); // the RED bar named in the instruction
  });

  it('IT-ENGINE-1: a failed-assertion result + a test file added completes the RED turn', async () => {
    const engine = makeEngine(undefined, redFake());
    enterRed(engine);
    writeResult(examplePhaseResult('failed-assertion'));
    engine.onDoneSignal();
    await flushRedGate();
    engine.onInjectable();
    engine.onInjectable();
    expect(h.emitError).not.toHaveBeenCalled();
    expect(reviewChained()).toBe(true); // completion chained the review turn
  });

  it('IT-ENGINE-2: a passing test result drives retry-then-error (the sync outcome clause)', async () => {
    const engine = makeEngine(undefined, redFake());
    enterRed(engine);
    writeResult(examplePhaseResult('passed'));
    engine.onDoneSignal();
    await flushRedGate(); // attempt 1 -> retry
    engine.onDoneSignal();
    await flushRedGate(); // attempt 2 -> error
    expect(h.emitError).toHaveBeenCalled();
    expect(reviewChained()).toBe(false);
  });

  it('IT-ENGINE-3: an errored result (compile/import — the marquee "not valid RED") drives retry-then-error', async () => {
    const engine = makeEngine(undefined, redFake());
    enterRed(engine);
    writeResult(examplePhaseResult('errored'));
    engine.onDoneSignal();
    await flushRedGate();
    engine.onDoneSignal();
    await flushRedGate();
    expect(h.emitError).toHaveBeenCalled();
    expect(reviewChained()).toBe(false);
  });

  it('IT-ENGINE-3b: a no-tests-selected result drives retry-then-error', async () => {
    const engine = makeEngine(undefined, redFake());
    enterRed(engine);
    writeResult(examplePhaseResult('no-tests-selected'));
    engine.onDoneSignal();
    await flushRedGate();
    engine.onDoneSignal();
    await flushRedGate();
    expect(h.emitError).toHaveBeenCalled();
  });

  it('IT-ENGINE-4: a failed-assertion result but NO test file added drives retry-then-error with a naming reason', async () => {
    const engine = makeEngine(undefined, redFake({ workingTreeTestPaths: async () => ({ ok: true, paths: [] }) }));
    enterRed(engine);
    writeResult(examplePhaseResult('failed-assertion'));
    engine.onDoneSignal();
    await flushRedGate();
    engine.onDoneSignal();
    await flushRedGate();
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('no test file was added'));
  });

  it('IT-ENGINE-4b: absent loop-capabilities surfaces a DISTINCT reason, not a completion-shortfall text', async () => {
    const engine = makeEngine(
      undefined,
      redFake({ workingTreeTestPaths: async () => ({ ok: false, cause: 'absent', reason: 'no loop-capabilities.yaml' }) }),
    );
    enterRed(engine);
    writeResult(examplePhaseResult('failed-assertion'));
    engine.onDoneSignal();
    await flushRedGate();
    engine.onDoneSignal();
    await flushRedGate();
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('loop-capabilities'));
    expect(h.emitError).not.toHaveBeenCalledWith(expect.stringContaining('done-signal received but'));
  });

  it('IT-ENGINE-5: a malformed result file drives retry-then-error', async () => {
    const engine = makeEngine(undefined, redFake());
    enterRed(engine);
    writeResult('outcome: failed-assertion\n'); // no captured-output section -> not well-formed (AC3)
    engine.onDoneSignal();
    await flushRedGate();
    engine.onDoneSignal();
    await flushRedGate();
    expect(h.emitError).toHaveBeenCalled();
    expect(reviewChained()).toBe(false);
  });

  it('IT-ENGINE-6: exit-direction — exit 0 rejects a failed-assertion claim; exit 5 allows it', async () => {
    // exit 0 -> may not claim RED
    const rejects = makeEngine(undefined, redFake({ recoverExitCode: async () => 0 }));
    enterRed(rejects);
    writeResult(examplePhaseResult('failed-assertion'));
    rejects.onDoneSignal();
    await flushRedGate();
    rejects.onDoneSignal();
    await flushRedGate();
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('exited 0'));

    // exit 5 (non-zero) -> RED allowed
    const allows = makeEngine(undefined, redFake({ recoverExitCode: async () => 5 }));
    enterRed(allows);
    writeResult(examplePhaseResult('failed-assertion'));
    allows.onDoneSignal();
    await flushRedGate();
    allows.onInjectable();
    allows.onInjectable();
    expect(reviewChained()).toBe(true);
  });

  it('IT-ENGINE-7: a completion:red def whose artifact binding does NOT resolve is unresolved, never a free pass', async () => {
    const engine = makeEngine(undefined, redFake());
    enterRed(engine, redDef(false)); // no output binding for work.artifact (the resume-case F1)
    writeResult(examplePhaseResult('failed-assertion'));
    engine.onDoneSignal(); // unresolved -> completionSatisfied false -> retry (SYNC path; not a RED gate)
    engine.onDoneSignal(); // -> error
    expect(h.emitError).toHaveBeenCalled();
    expect(reviewChained()).toBe(false); // never fabricated a pass on the done-signal alone
  });

  it('IT-ENGINE-8: a stall during the async RED gate errors the turn; the late gate still completes it (§27.12)', async () => {
    const { workingTreeTestPaths, resolve } = deferredWorkingTree();
    const engine = makeEngine(undefined, makeFakeCompletionPredicates({ workingTreeTestPaths }));
    enterRed(engine);
    writeResult(examplePhaseResult('failed-assertion'));
    engine.onDoneSignal(); // starts the async gate, awaiting the deferred workingTreeTestPaths
    engine.onStall(); // the runner errors while the gate is still pending
    expect(readAppLoopState(h.repo)?.status).toBe('error');
    resolve({ ok: true, paths: ['tests/a.test.ts'] }); // the gate resolves late — the done-signal was real
    await flushRedGate();
    expect(readAppLoopState(h.repo)?.status).toBe('working');
    expect(engine.activeTurnKey()).not.toBe('work-plan'); // advanced into the review round
  });

  it('IT-ENGINE-8b: a stale gate resolving after a retry rebuilt the turn cannot auto-complete it (identity guard)', async () => {
    const { workingTreeTestPaths, resolve } = deferredWorkingTree();
    const engine = makeEngine(undefined, makeFakeCompletionPredicates({ workingTreeTestPaths }));
    enterRed(engine);
    writeResult(examplePhaseResult('failed-assertion'));
    engine.onDoneSignal(); // starts the async gate for turn `a`
    engine.onStall(); // errors the turn
    engine.routeOut(h.repo, STEP, 'work-plan', 'retry'); // rebuilds `active` as a NEW in-flight turn (≠ a)
    resolve({ ok: true, paths: ['tests/a.test.ts'] }); // the STALE gate for `a` resolves...
    await flushRedGate();
    expect(reviewChained()).toBe(false); // ...but active !== a → the identity guard skips; the retry never auto-completed
    expect(readAppLoopState(h.repo)?.status).toBe('working'); // the retry turn is running, not fabricated-complete
  });

  it('IT-ENGINE-dedup: a duplicate done-signal while the gate is pending does not burn a second retry attempt', async () => {
    // The host watcher is not debounced (turnDoneFile) — the async gate must not let a double-fire consume both
    // MAX_ATTEMPTS. gate fails (no test file); two rapid signals -> ONE gate -> ONE fail -> retry (not error).
    const engine = makeEngine(undefined, redFake({ workingTreeTestPaths: async () => ({ ok: true, paths: [] }) }));
    enterRed(engine);
    writeResult(examplePhaseResult('failed-assertion'));
    engine.onDoneSignal(); // spawns the gate for `a`
    engine.onDoneSignal(); // duplicate while the gate is pending -> suppressed by redGatePendingFor
    await flushRedGate();
    expect(h.emitError).not.toHaveBeenCalled(); // only ONE attempt consumed -> retried, not errored
  });

  it('IT-ENGINE-9a: human-accept ALSO requires the async gate — no test file added → accept REFUSES (AC2 on the human path)', async () => {
    const engine = makeEngine(undefined, redFake({ workingTreeTestPaths: async () => ({ ok: true, paths: [] }) }));
    enterRed(engine);
    writeResult(examplePhaseResult('failed-assertion'));
    engine.onStall(); // error the turn (a stall, independent of the gate)
    expect(readAppLoopState(h.repo)?.status).toBe('error');
    engine.routeOut(h.repo, STEP, 'work-plan', 'accept');
    await flushRedGate();
    expect(readAppLoopState(h.repo)?.status).toBe('error'); // accept refused — §28.5.6 keeps "a test was added" machine-authoritative
    expect(reviewChained()).toBe(false);
  });

  it('IT-ENGINE-9b: human-accept finalizes when BOTH the sync clause and the async gate hold', async () => {
    const engine = makeEngine(undefined, redFake()); // workingTreeTestPaths -> paths: ['tests/a.test.ts']
    enterRed(engine);
    writeResult(examplePhaseResult('failed-assertion'));
    engine.onStall();
    expect(readAppLoopState(h.repo)?.status).toBe('error');
    engine.routeOut(h.repo, STEP, 'work-plan', 'accept');
    await flushRedGate();
    expect(readAppLoopState(h.repo)?.status).toBe('complete'); // both clauses held → finalized
  });

  it('IT-ENGINE-10: a non-RED (file) turn is unaffected — it completes SYNCHRONOUSLY on the done-signal', () => {
    const engine = makeEngine(); // the real sentinel predicates; a plain file def
    enterAndInjectWork(engine);
    writeArtifact(true);
    engine.onDoneSignal(); // NO flush needed — non-RED completion is synchronous
    engine.onInjectable();
    engine.onInjectable();
    expect(h.emitError).not.toHaveBeenCalled();
    expect(reviewChained()).toBe(true);
  });
});

// §28.5.3 — the GREEN completion gate: sync clause (result well-formed + outcome `passed` + build `built`),
// async gate (baseline present+branch-matched, frozen check via changedTestPaths head-omitted, exit-direction),
// and the NON-blocking detect-and-flag (§28.8.3) recorded at completion. Mirrors the RED gate's Option-C shape.
describe('§28.5.3 — the GREEN completion gate (Option C + non-blocking frozen flag)', () => {
  const reviewChained = (): boolean => h.injected.some((s) => s.includes(ROSTER[0]));
  const OID = 'a'.repeat(40);
  const seedBaseline = (branch = TEST_BRANCH, sha = OID): void => void recordBaselineCommit(h.repo, branch, sha);
  const greenFake = (overrides: Partial<LoopCompletionPredicates> = {}): LoopCompletionPredicates =>
    makeFakeCompletionPredicates({ changedTestPaths: async () => ({ ok: true, paths: [] }), ...overrides });
  const greenDef = (withBinding = true): LoopDefV2 => ({
    ...fileDef(),
    work: { recipe: join(h.repo, 'recipe', 'work.md'), artifact: 'green-result', completion: 'green' },
    outputs: withBinding ? [binding('green-result', h.resultPath)] : [],
  });
  const enterGreen = (engine: ReturnType<typeof createAppLoopEngine>, def: LoopDefV2 = greenDef()): void => {
    h.defResult = resolved(def);
    enterAndInjectWork(engine);
  };
  const writeGreen = (): void => writeResult(examplePhaseResult(GREEN_COMPLETING_OUTCOME, { build: GREEN_COMPLETING_BUILD_OUTCOME }));
  const flushGate = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  it('IT-GREEN-writer: entering a GREEN def injects a work prompt instructing the phase-result write (both classifications)', () => {
    const engine = makeEngine(undefined, greenFake());
    seedBaseline();
    enterGreen(engine);
    expect(h.injected[1]).toContain(basename(h.resultPath)); // the result file the engine threaded
    expect(h.injected[1]).toContain(PHASE_RESULT_GRAMMAR.capturedOutputHeading);
    expect(h.injected[1]).toContain(GREEN_COMPLETING_OUTCOME); // `passed`
    expect(h.injected[1]).toContain(GREEN_COMPLETING_BUILD_OUTCOME); // `built`
  });

  it('IT-GREEN-1: passed+built + no test changed completes the turn and records an EMPTY-paths flag', async () => {
    const engine = makeEngine(undefined, greenFake());
    seedBaseline();
    enterGreen(engine);
    writeGreen();
    engine.onDoneSignal();
    await flushGate();
    engine.onInjectable();
    engine.onInjectable();
    expect(h.emitError).not.toHaveBeenCalled();
    expect(reviewChained()).toBe(true); // completion chained the review turn (the flag did NOT block)
    expect(readChangedTests(h.repo)).toEqual({ step: STEP, paths: [] }); // checked, none changed (via the REAL reader)
  });

  it('IT-GREEN-2: a changed test file is FLAGGED (naming it) and the turn STILL completes (§28.8.3 non-blocking)', async () => {
    const engine = makeEngine(undefined, greenFake({ changedTestPaths: async () => ({ ok: true, paths: ['tests/a.test.ts'] }) }));
    seedBaseline();
    enterGreen(engine);
    writeGreen();
    engine.onDoneSignal();
    await flushGate();
    engine.onInjectable();
    engine.onInjectable();
    expect(reviewChained()).toBe(true); // still completes — detect-and-escalate, not a block
    expect(readChangedTests(h.repo)?.paths).toContain('tests/a.test.ts'); // the flag names the changed file
  });

  it('IT-GREEN-2b: the human-ACCEPT (override) route ALSO records the flag', async () => {
    const engine = makeEngine(undefined, greenFake({ changedTestPaths: async () => ({ ok: true, paths: ['tests/a.test.ts'] }) }));
    seedBaseline();
    enterGreen(engine);
    writeGreen();
    engine.onStall(); // error the turn, so the human takes the accept route
    expect(readAppLoopState(h.repo)?.status).toBe('error');
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    await flushGate();
    expect(readAppLoopState(h.repo)?.status).toBe('complete'); // sync+gate held → finalized
    expect(readChangedTests(h.repo)?.paths).toContain('tests/a.test.ts'); // recorded on the accept route too
  });

  it('IT-GREEN-3a: a failed-assertion outcome (build built) does NOT complete → retry-then-error', async () => {
    const engine = makeEngine(undefined, greenFake());
    seedBaseline();
    enterGreen(engine);
    writeResult(examplePhaseResult('failed-assertion', { build: 'built' }));
    engine.onDoneSignal();
    await flushGate();
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).toHaveBeenCalled();
    expect(reviewChained()).toBe(false);
    expect(readChangedTests(h.repo)).toBeNull(); // never completed → no flag
  });

  it('IT-GREEN-3b: passed but build-failed does NOT complete → retry-then-error', async () => {
    const engine = makeEngine(undefined, greenFake());
    seedBaseline();
    enterGreen(engine);
    writeResult(examplePhaseResult('passed', { build: 'build-failed' }));
    engine.onDoneSignal();
    await flushGate();
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).toHaveBeenCalled();
    expect(reviewChained()).toBe(false);
  });

  it('IT-GREEN-3c: passed but NO build line (resultBuildOutcome null) does NOT complete → retry-then-error', async () => {
    const engine = makeEngine(undefined, greenFake());
    seedBaseline();
    enterGreen(engine);
    writeResult(examplePhaseResult('passed')); // no build field → not `built`
    engine.onDoneSignal();
    await flushGate();
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).toHaveBeenCalled();
    expect(reviewChained()).toBe(false);
  });

  it('IT-GREEN-4: exit-direction — exit non-zero rejects a passed claim (OPPOSITE of RED); exit 0 allows it', async () => {
    // exit 1 -> may not claim GREEN
    const rejects = makeEngine(undefined, greenFake({ recoverExitCode: async () => 1 }));
    seedBaseline();
    enterGreen(rejects);
    writeGreen();
    rejects.onDoneSignal();
    await flushGate();
    rejects.onDoneSignal();
    await flushGate();
    expect(h.emitError).toHaveBeenCalled();
    expect(reviewChained()).toBe(false);

    // exit 0 -> GREEN allowed
    const allows = makeEngine(undefined, greenFake({ recoverExitCode: async () => 0 }));
    seedBaseline();
    enterGreen(allows);
    writeGreen();
    allows.onDoneSignal();
    await flushGate();
    allows.onInjectable();
    allows.onInjectable();
    expect(reviewChained()).toBe(true);
  });

  it('IT-GREEN-baseline-a: NO recorded baseline blocks GREEN (the frozen check cannot run) → retry-then-error, no flag', async () => {
    const engine = makeEngine(undefined, greenFake());
    // no seedBaseline()
    enterGreen(engine);
    writeGreen();
    engine.onDoneSignal();
    await flushGate();
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('baseline'));
    expect(reviewChained()).toBe(false);
    expect(readChangedTests(h.repo)).toBeNull();
  });

  it('IT-GREEN-baseline-b: a baseline recorded on a DIFFERENT branch blocks GREEN (branch-match)', async () => {
    const engine = makeEngine(undefined, greenFake());
    seedBaseline('a-different-branch', OID); // recorded, but not this run's branch
    enterGreen(engine);
    writeGreen();
    engine.onDoneSignal();
    await flushGate();
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('baseline'));
    expect(reviewChained()).toBe(false);
  });

  // §28.5.1 — a detached HEAD (currentBranch → null) cannot prove "same slice", so GREEN blocks even with a
  // baseline recorded (fail toward firing) — the null-branch guard the branch-key relies on.
  it('IT-GREEN-baseline-c: a null current branch (detached HEAD) blocks GREEN even with a baseline recorded', async () => {
    const engine = makeEngine(undefined, greenFake(), null);
    seedBaseline(TEST_BRANCH, OID);
    enterGreen(engine);
    writeGreen();
    engine.onDoneSignal();
    await flushGate();
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('baseline'));
    expect(reviewChained()).toBe(false);
  });

  it('IT-GREEN-capfail: an absent loop-capabilities surfaces a DISTINCT reason naming the BASELINE COMMIT, not the RED gate\'s working-tree wording', async () => {
    // The GREEN frozen check sources globs from the RED baseline COMMIT's blob, so `absent` means "not in that
    // commit" — NOT the RED gate's working-tree "the repository has no loop-capabilities file". A repo whose
    // loop-capabilities.yaml is uncommitted at the baseline passes RED but blocks GREEN; the operator must be
    // told to commit it and re-run RED (Retry is futile — the baseline SHA is fixed), so the reason names the
    // baseline, distinct from the RED wording.
    const engine = makeEngine(undefined, greenFake({ changedTestPaths: async () => ({ ok: false, cause: 'absent', reason: 'no loop-capabilities.yaml' }) }));
    seedBaseline();
    enterGreen(engine);
    writeGreen();
    engine.onDoneSignal();
    await flushGate();
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('loop-capabilities'));
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('baseline')); // names the baseline commit, not "the repository"
    expect(h.emitError).not.toHaveBeenCalledWith(expect.stringContaining('done-signal received but'));
  });

  it('IT-GREEN-recordfail: a throwing recordChangedTests NEVER aborts the advance (best-effort wrap)', async () => {
    const engine = makeEngine(undefined, greenFake({ changedTestPaths: async () => ({ ok: true, paths: ['tests/a.test.ts'] }) }));
    seedBaseline();
    enterGreen(engine);
    writeGreen();
    h.recordChangedTestsImpl = () => { throw new Error('disk full'); }; // the flag write fails...
    engine.onDoneSignal();
    await flushGate();
    engine.onInjectable();
    engine.onInjectable();
    expect(reviewChained()).toBe(true); // ...the turn still advances to review (the write is best-effort)
    expect(h.emitError).not.toHaveBeenCalled(); // a flag-write failure is NOT surfaced as a blocking loop error
    expect(h.audit).toHaveBeenCalled(); // it is audited
  });

  it('IT-GREEN-9a: human-accept REFUSES when the sync clause fails (not passed) — no fabricated completion', async () => {
    const engine = makeEngine(undefined, greenFake());
    seedBaseline();
    enterGreen(engine);
    writeResult(examplePhaseResult('failed-assertion', { build: 'built' }));
    engine.onStall();
    expect(readAppLoopState(h.repo)?.status).toBe('error');
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    await flushGate();
    expect(readAppLoopState(h.repo)?.status).toBe('error'); // refused — the sync clause (passed) is unmet
  });

  it('IT-GREEN-8: a stall during the async gate errors the turn; the late gate still completes it and records its flag (§27.12)', async () => {
    const { changedTestPaths, resolve } = deferredChangedTestPaths();
    const engine = makeEngine(undefined, makeFakeCompletionPredicates({ changedTestPaths }));
    seedBaseline();
    enterGreen(engine);
    writeGreen();
    engine.onDoneSignal(); // starts the async gate, awaiting the deferred changedTestPaths
    engine.onStall(); // the runner errors while the gate is still pending
    expect(readAppLoopState(h.repo)?.status).toBe('error');
    resolve({ ok: true, paths: ['tests/a.test.ts'] }); // the gate resolves late, with a changed test
    await flushGate();
    expect(readAppLoopState(h.repo)?.status).toBe('working');
    expect(engine.activeTurnKey()).not.toBe(TURN_KEY); // advanced into the review round
    expect(readChangedTests(h.repo)).toEqual({ step: STEP, paths: ['tests/a.test.ts'] });
  });

  it('IT-GREEN-8b: a stale gate resolving after a retry rebuilt the turn records no flag against the fresh turn (identity guard)', async () => {
    const { changedTestPaths, resolve } = deferredChangedTestPaths();
    const engine = makeEngine(undefined, makeFakeCompletionPredicates({ changedTestPaths }));
    seedBaseline();
    enterGreen(engine);
    writeGreen();
    engine.onDoneSignal(); // starts the async gate for turn `a`
    engine.onStall(); // errors the turn
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry'); // rebuilds `active` as a NEW turn (≠ a)
    engine.onInjectable(); // drain the retry boundary so the retry turn is FULLY in-flight (awaiting its own signal)
    resolve({ ok: true, paths: ['tests/a.test.ts'] }); // the STALE gate for `a` resolves (ok) against the fresh turn...
    await flushGate();
    // ...active !== a → the identity guard skips BOTH the stash write and `runner.onDoneSignal(gate)`, so the stale
    // gate can neither complete the fresh in-flight turn nor record its paths against it:
    expect(reviewChained()).toBe(false); // the fresh turn was NOT completed by the stale gate
    expect(readAppLoopState(h.repo)?.status).toBe('working'); // the retry turn runs, not fabricated-complete
    expect(readChangedTests(h.repo)).toBeNull(); // the stale gate's paths were never recorded against the fresh turn
  });

  it('IT-GREEN-dedup: a duplicate done-signal while the gate is pending does not burn a second retry attempt', async () => {
    // The host watcher is not debounced; a double-fire must not consume both MAX_ATTEMPTS. Gate FAILS (exit 1);
    // two rapid signals → ONE gate (asyncGatePendingFor) → ONE fail → retry (not error).
    const engine = makeEngine(undefined, greenFake({ recoverExitCode: async () => 1 }));
    seedBaseline();
    enterGreen(engine);
    writeGreen();
    engine.onDoneSignal(); // spawns the gate for `a`
    engine.onDoneSignal(); // duplicate while the gate is pending → suppressed by asyncGatePendingFor
    await flushGate();
    expect(h.emitError).not.toHaveBeenCalled(); // only ONE attempt consumed → retried, not errored
  });

  it('IT-GREEN-flag-survives: the flag persists through review/consolidate to the gate (disjoint from run-state)', async () => {
    const engine = makeEngine(undefined, greenFake({ changedTestPaths: async () => ({ ok: true, paths: ['tests/a.test.ts'] }) }));
    seedBaseline();
    enterGreen(engine);
    writeGreen();
    engine.onDoneSignal();
    await flushGate();
    // drive review → consolidate → the clean gate (many wholesale run-state writes in between):
    engine.onInjectable();
    engine.onInjectable();
    writeRoundReport(1, []);
    engine.onDoneSignal();
    await flushGate();
    engine.onInjectable();
    engine.onInjectable();
    completeConsolidate(engine, 1, 'verdict: clean\n');
    expect(readAppLoopState(h.repo)?.status).toBe('complete'); // reached the gate
    expect(readChangedTests(h.repo)?.paths).toContain('tests/a.test.ts'); // the flag survived every run-state write
  });
});

// §28.5.3/§28.6/S5 — the REFACTOR loop's engine shape: a `work.completion: refactor` loop's work turn is a
// `commits` turn (the phase gate is on the review ROUND, §28.6 "it is review-and-fix"), so it advances to
// review round 1 on the done-signal alone; the review round is then instructed to write a round-keyed
// phase-result file (the gate that R5 wires). These pin the turn SHAPE, observed through the injected prompts
// and the engine's advance — never a private-field peek.
describe('§28.5.3 — the refactor loop review-turn shape', () => {
  it('IT-REFAC-workturn: a refactor loop\'s work turn is a commits turn — advances to review on the done-signal alone (activeTurnFor pin)', () => {
    // A BOUND work.artifact would map to a marker-`file` turn WITHOUT the refactor→commits arm; the marker is
    // never written here, so before the arm the turn cannot complete and never reaches review (RED).
    h.defResult = resolved(refactorDefBound());
    const engine = makeEngine();
    enterAndInjectWork(engine); // enter + the work prompt injects
    engine.onDoneSignal(); // commits work turn completes on the done-signal alone → chains review round 1
    engine.onInjectable(); // the pre-review boundary drains
    engine.onInjectable(); // the review-and-fix prompt injects
    expect(engine.activeTurnKey()).toBe(REVIEW_KEY); // advanced to the review round, not stuck in the work turn
    expect(h.injected[h.injected.length - 1]).toContain('turn-done:review-plan'); // the review prompt injected
  });

  it('IT-REFAC-turn: the refactor loop\'s review round is instructed to write the round-keyed result file', () => {
    h.defResult = resolved(refactorDef());
    const engine = makeEngine();
    driveToReviewInjected(engine); // work (commits) → review round 1 prompt injects
    // The injected review prompt names the round-keyed refactor-result rel (from resolveRefactorResultLocation).
    expect(h.injected[h.injected.length - 1]).toContain(refactorResultRel(1));
    expect(h.injected[h.injected.length - 1]).toContain(PHASE_RESULT_GRAMMAR.capturedOutputHeading);
  });

  it('IT-REFAC-turn: a NON-refactor loop\'s review round names no result file (regression — existing loops unchanged)', () => {
    h.defResult = resolved(fileDef());
    const engine = makeEngine();
    driveToReviewInjected(engine);
    expect(h.injected[h.injected.length - 1]).not.toContain(refactorResultRel(1));
    expect(h.injected[h.injected.length - 1]).not.toContain('.agent-terminal/loop/refactor-results/');
  });

  it('IT-REFAC-unresolvable-result: an unresolvable refactor-result location stops the round in a routable error (no fabricated pass)', () => {
    h.defResult = resolved(refactorDef());
    const engine = makeEngine();
    h.refactorResultLocationNull = true; // the loop area is unresolvable
    enterAndInjectWork(engine);
    engine.onDoneSignal(); // work completes (commits) → enterReview → reviewTurnFor resolves the result location → null
    expect(h.emitError).toHaveBeenCalled(); // surfaced as a routable §27 loop error
    expect(readAppLoopState(h.repo)?.status).toBe('error');
  });
});

// §28.5.3/§28.8.3/S5 — the REFACTOR round completion GATE + the NON-blocking frozen probe. A refactor round is
// done ⟺ {round report well-formed} ∧ {result shape-valid ∧ outcome == passed} ∧ {exit == 0 where recoverable}
// (§28.5.3:124, the GREEN exit-direction via a PrecomputedGate) — softer than GREEN only in carrying no build.
// The frozen check is a best-effort SIDE probe that records the non-blocking changed-test flag; a probe that
// cannot run (no baseline / capfail) records NO flag, is AUDITED, and does NOT block the round (the opposite of
// GREEN, whose frozen check's baseline guard blocks).
describe('§28.5.3 — the refactor round completion gate + non-blocking frozen probe', () => {
  const OID = 'a'.repeat(40);
  const seedBaseline = (branch = TEST_BRANCH, sha = OID): void => void recordBaselineCommit(h.repo, branch, sha);
  const refFake = (overrides: Partial<LoopCompletionPredicates> = {}): LoopCompletionPredicates =>
    makeFakeCompletionPredicates({ changedTestPaths: async () => ({ ok: true, paths: [] }), ...overrides });
  const flushGate = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const passed = (): string => examplePhaseResult(REFACTOR_COMPLETING_OUTCOME); // `outcome: passed`, no build
  const writeRefactorResult = (content: string, round = 1): void => {
    const p = refactorResultFile(h.repo, round)!;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  };
  const writeMalformedReport = (round = 1): void => {
    const p = roundReportFile(h.repo, round)!;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '# incomplete — a persona is missing\n'); // present but NOT roundReportWellFormed
  };
  /** enter a refactor loop → work (commits) completes → the review-and-fix round-1 prompt injects. */
  const driveToRefactorReview = (engine: ReturnType<typeof createAppLoopEngine>): void => {
    h.defResult = resolved(refactorDef());
    enterAndInjectWork(engine);
    engine.onDoneSignal(); // commits work turn completes → chains review round 1
    engine.onInjectable();
    engine.onInjectable();
  };
  /** The round completed iff it chained the consolidator (its turnKey is now the active one). */
  const completed = (engine: ReturnType<typeof createAppLoopEngine>): boolean => engine.activeTurnKey() === CONSOLIDATE_KEY;

  it('IT-REFAC-1: report + passing result + no changed test completes the round and records an EMPTY-paths flag', async () => {
    const engine = makeEngine(undefined, refFake());
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []);
    writeRefactorResult(passed());
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).not.toHaveBeenCalled();
    expect(completed(engine)).toBe(true); // chained the consolidator — the round is done
    expect(readChangedTests(h.repo)).toEqual({ step: STEP, paths: [] }); // checked, none changed (REAL reader)
  });

  it('IT-REFAC-2: a changed test is FLAGGED (naming it) and the round STILL completes (§28.8.3 non-blocking)', async () => {
    const engine = makeEngine(undefined, refFake({ changedTestPaths: async () => ({ ok: true, paths: ['tests/a.test.ts'] }) }));
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []);
    writeRefactorResult(passed());
    engine.onDoneSignal();
    await flushGate();
    expect(completed(engine)).toBe(true); // still completes — detect-and-escalate, not a block
    expect(readChangedTests(h.repo)?.paths).toContain('tests/a.test.ts');
  });

  it('IT-REFAC-3a: a failed-assertion result does NOT complete the round → retry-then-error, no flag', async () => {
    const engine = makeEngine(undefined, refFake());
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []);
    writeRefactorResult(examplePhaseResult('failed-assertion'));
    engine.onDoneSignal();
    await flushGate();
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).toHaveBeenCalled();
    expect(completed(engine)).toBe(false);
    expect(readChangedTests(h.repo)).toBeNull(); // never completed → no flag
  });

  it('IT-REFAC-3c: an absent/malformed result does NOT complete the round → retry-then-error', async () => {
    const engine = makeEngine(undefined, refFake());
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []);
    writeRefactorResult('outcome: passed\n'); // no captured-output section → not shape-valid
    engine.onDoneSignal();
    await flushGate();
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).toHaveBeenCalled();
    expect(completed(engine)).toBe(false);
  });

  it('IT-REFAC-3d: a malformed REPORT with a passing result does NOT complete (both clauses required)', async () => {
    const engine = makeEngine(undefined, refFake());
    seedBaseline();
    driveToRefactorReview(engine);
    writeMalformedReport(1);
    writeRefactorResult(passed());
    engine.onDoneSignal();
    await flushGate();
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).toHaveBeenCalled();
    expect(completed(engine)).toBe(false);
  });

  it('IT-REFAC-exit: exit-direction — a non-zero test exit blocks the refactor round (§28.5.3:124, same direction as GREEN); exit 0 completes', async () => {
    // §28.5.3:124 — a refactor round carries the same recoverable exit-code direction as GREEN: a fixer that
    // claims `passed` while the real test exit is non-zero may not complete the round. DORMANT until #92 wires
    // recoverExitCode; injecting an exit code exercises the direction.
    const rejects = makeEngine(undefined, refFake({ recoverExitCode: async () => 1 }));
    seedBaseline();
    driveToRefactorReview(rejects);
    writeRoundReport(1, []);
    writeRefactorResult(passed());
    rejects.onDoneSignal();
    await flushGate();
    rejects.onDoneSignal();
    await flushGate();
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('exited 1'));
    expect(completed(rejects)).toBe(false);

    // exit 0 -> the round completes
    const allows = makeEngine(undefined, refFake({ recoverExitCode: async () => 0 }));
    seedBaseline();
    driveToRefactorReview(allows);
    writeRoundReport(1, []);
    writeRefactorResult(passed());
    allows.onDoneSignal();
    await flushGate();
    expect(completed(allows)).toBe(true);
  });

  it('IT-REFAC-exit-accept: human-ACCEPT REFUSES a non-zero test exit (machine ground truth, not overridable — same as GREEN accept)', async () => {
    const engine = makeEngine(undefined, refFake({ recoverExitCode: async () => 1 }));
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []); // well-formed report + passing result
    writeRefactorResult(passed());
    engine.onStall();
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    await flushGate();
    expect(readAppLoopState(h.repo)?.status).toBe('error'); // refused — the exit gate is machine-authoritative on accept too
  });

  it('IT-REFAC-exit-throws: a THROWING recoverExitCode fails toward firing — the round BLOCKS, never falsely completes', async () => {
    // §28.5.3 — refactorAsyncGate must never let broken exit-recovery pass the round: a throw yields a BLOCKING
    // gate ('completion check failed'), the fail-toward-firing direction (the RED/GREEN async-gate twin).
    const engine = makeEngine(undefined, refFake({ recoverExitCode: async () => { throw new Error('boom'); } }));
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []);
    writeRefactorResult(passed());
    engine.onDoneSignal();
    await flushGate();
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).toHaveBeenCalledWith(expect.stringContaining('completion check failed'));
    expect(completed(engine)).toBe(false);
  });

  it('IT-REFAC-nobaseline: an absent baseline does NOT block the round (non-blocking probe) — completes, no flag, audited', async () => {
    const engine = makeEngine(undefined, refFake());
    // no seedBaseline() — the probe cannot run, but the round still completes on the sync clause (softer than GREEN)
    driveToRefactorReview(engine);
    writeRoundReport(1, []);
    writeRefactorResult(passed());
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).not.toHaveBeenCalled(); // NOT blocked (the opposite of IT-GREEN-baseline-a)
    expect(completed(engine)).toBe(true);
    expect(readChangedTests(h.repo)).toBeNull(); // no flag — the probe could not run
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('frozen probe'), 1); // audited, never silent
  });

  it('IT-REFAC-capfail: a capabilities-load failure does NOT block the round — completes, no flag, audited', async () => {
    const engine = makeEngine(undefined, refFake({ changedTestPaths: async () => ({ ok: false, cause: 'absent', reason: 'no loop-capabilities.yaml' }) }));
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []);
    writeRefactorResult(passed());
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).not.toHaveBeenCalled(); // NOT blocked (the opposite of IT-GREEN-capfail)
    expect(completed(engine)).toBe(true);
    expect(readChangedTests(h.repo)).toBeNull();
    // The probe's cause is baseline-COMMIT-sourced (the same shared core the GREEN gate reads), so the audit
    // names the baseline commit — the GREEN twin's baseline wording, NOT the RED gate's working-tree "repository".
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('frozen probe'), 1);
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('the RED baseline commit'), 1);
    expect(h.audit).not.toHaveBeenCalledWith(h.repo, expect.stringContaining('the repository has no loop-capabilities'), 1);
  });

  it('IT-REFAC-probe-throws: a THROWING frozen probe still completes the round — no block, no hang, audited', async () => {
    // The probe is fired `void reviewRoundFrozenProbe(a).then(...)` with no outer .catch, so a reject would leave
    // asyncGatePendingFor pinned and the round would hang; its internal try/catch must audit and yield null instead.
    const engine = makeEngine(undefined, refFake({ changedTestPaths: async () => { throw new Error('git exploded'); } }));
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []);
    writeRefactorResult(passed());
    engine.onDoneSignal();
    await flushGate();
    expect(completed(engine)).toBe(true); // the round still completes on the sync clause
    expect(h.emitError).not.toHaveBeenCalled();
    expect(readChangedTests(h.repo)).toBeNull(); // the probe threw — no flag
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('frozen probe error'), 1);
  });

  it('IT-REFAC-recordfail: a throwing recordChangedTests NEVER aborts the advance (best-effort wrap)', async () => {
    const engine = makeEngine(undefined, refFake({ changedTestPaths: async () => ({ ok: true, paths: ['tests/a.test.ts'] }) }));
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []);
    writeRefactorResult(passed());
    h.recordChangedTestsImpl = () => { throw new Error('disk full'); };
    engine.onDoneSignal();
    await flushGate();
    expect(completed(engine)).toBe(true); // the round still advances (the flag write is best-effort)
    expect(h.emitError).not.toHaveBeenCalled();
    // the record failure is AUDITED (never silently swallowed) — asserted on the specific message so the check
    // fails if the best-effort catch stops auditing, and so the audit is the refactor record-failure path.
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('changed-tests flag record failed'), 1);
  });

  it('IT-REFAC-8: a stall during the probe errors the round; the late probe still completes it and records its flag (§27.12)', async () => {
    const { changedTestPaths, resolve } = deferredChangedTestPaths();
    const engine = makeEngine(undefined, makeFakeCompletionPredicates({ changedTestPaths }));
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []);
    writeRefactorResult(passed());
    engine.onDoneSignal(); // starts the probe, awaiting the deferred changedTestPaths
    engine.onStall(); // the runner errors the review round while the probe is pending
    expect(readAppLoopState(h.repo)?.status).toBe('error');
    resolve({ ok: true, paths: ['tests/a.test.ts'] }); // the probe resolves late, with a changed test
    await flushGate();
    expect(completed(engine)).toBe(true);
    expect(readChangedTests(h.repo)).toEqual({ step: STEP, paths: ['tests/a.test.ts'] });
  });

  it('IT-REFAC-dedup: a duplicate done-signal while the probe is pending does not burn a second retry attempt', async () => {
    // The host watcher is not debounced; a double-fire must not consume both MAX_ATTEMPTS. The round is NOT
    // passing (won't complete); two rapid signals → ONE probe (asyncGatePendingFor) → ONE retry (not error).
    const engine = makeEngine(undefined, refFake());
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []);
    writeRefactorResult(examplePhaseResult('failed-assertion')); // not passing → the round will not complete
    engine.onDoneSignal(); // spawns the probe for `a`
    engine.onDoneSignal(); // duplicate while the probe is pending → suppressed by asyncGatePendingFor
    await flushGate();
    expect(h.emitError).not.toHaveBeenCalled(); // only ONE attempt consumed → retried, not errored
  });

  it('IT-REFAC-8b: a stale probe resolving after `active` moved to a fresh turn records no flag against it (identity guard)', async () => {
    // A review-round retry re-runs the SAME turn object (unlike a work-turn retry), so the `active !== a` branch
    // is reached instead by a concurrent re-entry after the round errors — the defense-in-depth case.
    const { changedTestPaths, resolve } = deferredChangedTestPaths();
    const engine = makeEngine(undefined, makeFakeCompletionPredicates({ changedTestPaths }));
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []);
    writeRefactorResult(passed());
    engine.onDoneSignal(); // starts the probe for the review round `a`
    engine.onStall(); // errors the round → the runner is idle, so a fresh turn can enter
    h.defResult = resolved(refactorDef());
    engine.enter(h.repo, 'plan-loop', STEP, 're-entry'); // `active` is now a DIFFERENT turn than the pending probe's `a`
    resolve({ ok: true, paths: ['tests/a.test.ts'] }); // the STALE probe for `a` resolves against the fresh turn...
    await flushGate();
    expect(readChangedTests(h.repo)).toBeNull(); // ...the identity guard skips the stash; no flag recorded
  });

  it('IT-REFAC-2b-a: human-ACCEPT keeps a malformed report when the result passes, and records the flag', async () => {
    const engine = makeEngine(undefined, refFake({ changedTestPaths: async () => ({ ok: true, paths: ['tests/a.test.ts'] }) }));
    seedBaseline();
    driveToRefactorReview(engine);
    writeMalformedReport(1); // present but malformed — the override relaxes report well-formedness
    writeRefactorResult(passed());
    engine.onStall();
    expect(readAppLoopState(h.repo)?.status).toBe('error');
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    await flushGate();
    expect(readAppLoopState(h.repo)?.status).toBe('complete'); // finalized (report well-formedness relaxed)
    expect(readChangedTests(h.repo)?.paths).toContain('tests/a.test.ts'); // flag recorded on the accept route too
  });

  it('IT-REFAC-2b-throws: human-ACCEPT still finalizes when the frozen probe throws (acceptFinalize is inside the probe .then)', async () => {
    // On this route acceptFinalize runs INSIDE `reviewRoundFrozenProbe(a).then(...)`, so a reject would silently
    // never finalize the human's Accept; the probe's internal try/catch must yield null so acceptFinalize still runs.
    const engine = makeEngine(undefined, refFake({ changedTestPaths: async () => { throw new Error('git exploded'); } }));
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []); // well-formed report + passing result
    writeRefactorResult(passed());
    engine.onStall();
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    await flushGate();
    expect(readAppLoopState(h.repo)?.status).toBe('complete'); // finalized despite the probe throw
    expect(readChangedTests(h.repo)).toBeNull(); // the probe threw — no flag
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('frozen probe error'), 1);
  });

  it('IT-REFAC-2b-b: human-ACCEPT REFUSES a non-passing result (passed is machine ground truth, not overridable)', async () => {
    const engine = makeEngine(undefined, refFake());
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []); // well-formed report
    writeRefactorResult(examplePhaseResult('failed-assertion')); // not passing
    engine.onStall();
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    await flushGate();
    expect(readAppLoopState(h.repo)?.status).toBe('error'); // refused — AC2 route-invariant
  });

  it('IT-REFAC-2b-c: human-ACCEPT REFUSES an absent result (the override never relaxes presence)', async () => {
    const engine = makeEngine(undefined, refFake());
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []); // report present
    // no writeRefactorResult → the result file is absent
    engine.onStall();
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    await flushGate();
    expect(readAppLoopState(h.repo)?.status).toBe('error'); // refused — no result to accept
  });

  it('IT-REFAC-2b-d: human-ACCEPT REFUSES an absent report (existing presence guard)', async () => {
    const engine = makeEngine(undefined, refFake());
    seedBaseline();
    driveToRefactorReview(engine);
    // no report written
    writeRefactorResult(passed());
    engine.onStall();
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    await flushGate();
    expect(readAppLoopState(h.repo)?.status).toBe('error'); // refused — no report to accept
  });

  // AC1's "records a commit" clause: the commit is the generic S2 gate-commit side-effect (appGateDecision's
  // runCommitSideEffect, wired in index.ts), which fires on the human's gate DECISION — a layer these engine ITs
  // do not drive. It is pinned end-to-end for the refactor path by E2E-REFAC-1 (approve → HEAD+1 with the
  // `refactor:` label). These ITs pin the "completes" clause (chaining the consolidator, then reaching the gate).
  it('IT-REFAC-multiround: a persisting change is re-reported each round; the flag survives review→consolidate to the gate', async () => {
    // The probe is cumulative baseline↔working-tree, so a round-1 change is re-reported; replace-semantics
    // preserves the flag. Drive round 1 → consolidator clean → gate; the flag is still present at the gate.
    const engine = makeEngine(undefined, refFake({ changedTestPaths: async () => ({ ok: true, paths: ['tests/a.test.ts'] }) }));
    seedBaseline();
    driveToRefactorReview(engine);
    writeRoundReport(1, []);
    writeRefactorResult(passed());
    engine.onDoneSignal(); // round 1 completes (flag recorded) → consolidator
    await flushGate();
    engine.onInjectable();
    engine.onInjectable();
    completeConsolidate(engine, 1, 'verdict: clean\n');
    expect(readAppLoopState(h.repo)?.status).toBe('complete'); // reached the gate
    expect(readChangedTests(h.repo)?.paths).toContain('tests/a.test.ts'); // the flag survived every run-state write
  });
});

// §28.5.3/§28.8.3 — a GREEN loop's review-and-fix rounds edit tests too, so each completed round re-records the
// changed-test flag (cumulative since the RED baseline) on both completion routes, never blocking the round. A
// plain review round of a non-GREEN, non-refactor loop runs no probe.
describe('§28.5.3 — a GREEN loop review round refreshes the changed-test flag', () => {
  const OID = 'a'.repeat(40);
  const EDITED = 'tests/a.test.ts';
  const seedBaseline = (): void => void recordBaselineCommit(h.repo, TEST_BRANCH, OID);
  const flushGate = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const greenDef = (): LoopDefV2 => ({
    ...fileDef(),
    work: { recipe: join(h.repo, 'recipe', 'work.md'), artifact: 'green-result', completion: 'green' },
    outputs: [binding('green-result', h.resultPath)],
  });
  /** The working tree the frozen check diffs against the baseline — the test edits it between turns. */
  let changedSinceBaseline: () => ReturnType<LoopCompletionPredicates['changedTestPaths']>;
  const greenReviewFake = (): LoopCompletionPredicates =>
    makeFakeCompletionPredicates({ changedTestPaths: () => changedSinceBaseline() });
  const completed = (engine: ReturnType<typeof createAppLoopEngine>): boolean => engine.activeTurnKey() === CONSOLIDATE_KEY;

  /** GREEN work turn completes with no test changed (flag `[]`), then the review round-1 prompt injects. */
  const driveGreenToReview = async (engine: ReturnType<typeof createAppLoopEngine>): Promise<void> => {
    changedSinceBaseline = async () => ({ ok: true, paths: [] });
    seedBaseline();
    h.defResult = resolved(greenDef());
    enterAndInjectWork(engine);
    writeResult(examplePhaseResult(GREEN_COMPLETING_OUTCOME, { build: GREEN_COMPLETING_BUILD_OUTCOME }));
    engine.onDoneSignal();
    await flushGate();
    engine.onInjectable();
    engine.onInjectable();
    expect(readChangedTests(h.repo)).toEqual({ step: STEP, paths: [] });
  };

  it('IT-GREEN-REVIEW-1: a review round that edits a test re-records the flag naming it (done-signal route)', async () => {
    const engine = makeEngine(undefined, greenReviewFake());
    await driveGreenToReview(engine);
    changedSinceBaseline = async () => ({ ok: true, paths: [EDITED] });
    writeRoundReport(1, []);
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).not.toHaveBeenCalled();
    expect(completed(engine)).toBe(true);
    expect(readChangedTests(h.repo)).toEqual({ step: STEP, paths: [EDITED] });
  });

  it('IT-GREEN-REVIEW-2: the human-ACCEPT route of a GREEN review round also re-records the flag', async () => {
    const engine = makeEngine(undefined, greenReviewFake());
    await driveGreenToReview(engine);
    changedSinceBaseline = async () => ({ ok: true, paths: [EDITED] });
    writeRoundReport(1, []);
    engine.onStall();
    expect(readAppLoopState(h.repo)?.status).toBe('error');
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    await flushGate();
    expect(readAppLoopState(h.repo)?.status).toBe('complete');
    expect(readChangedTests(h.repo)).toEqual({ step: STEP, paths: [EDITED] });
  });

  it('IT-GREEN-REVIEW-resume: a relaunch-reconstructed GREEN review round records the flag on accept', async () => {
    changedSinceBaseline = async () => ({ ok: true, paths: [EDITED] });
    seedBaseline();
    h.defResult = resolved(greenDef());
    writeRoundReport(1, []);
    writeAppLoopState(h.repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'error', errorReason: 'stalled', round: 1 }, FIXED);
    const engine = makeEngine(undefined, greenReviewFake());
    engine.resume(h.repo);
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    await flushGate();
    expect(readAppLoopState(h.repo)?.status).toBe('complete');
    expect(readChangedTests(h.repo)).toEqual({ step: STEP, paths: [EDITED] });
  });

  it('IT-GREEN-REVIEW-noprobe: a probe that cannot run leaves the round completing and is audited', async () => {
    const engine = makeEngine(undefined, greenReviewFake());
    await driveGreenToReview(engine);
    changedSinceBaseline = async () => { throw new Error('git exploded'); };
    writeRoundReport(1, []);
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).not.toHaveBeenCalled();
    expect(completed(engine)).toBe(true);
    expect(readChangedTests(h.repo)).toEqual({ step: STEP, paths: [] });
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('frozen probe error'), 1);
  });

  it('IT-GREEN-REVIEW-recordfail: a failing flag write is audited and never aborts the round', async () => {
    const engine = makeEngine(undefined, greenReviewFake());
    await driveGreenToReview(engine);
    changedSinceBaseline = async () => ({ ok: true, paths: [EDITED] });
    h.recordChangedTestsImpl = () => { throw new Error('disk full'); };
    writeRoundReport(1, []);
    engine.onDoneSignal();
    await flushGate();
    expect(completed(engine)).toBe(true);
    expect(h.emitError).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(h.repo, expect.stringContaining('changed-tests flag record failed'), 1);
  });

  it('IT-GREEN-REVIEW-stale: a stale probe resolving after `active` moved to a fresh turn records nothing against it', async () => {
    const engine = makeEngine(undefined, greenReviewFake());
    await driveGreenToReview(engine);
    const { changedTestPaths, resolve } = deferredChangedTestPaths();
    changedSinceBaseline = () => changedTestPaths({ repoDir: h.repo, baseline: OID });
    writeRoundReport(1, []);
    engine.onDoneSignal();
    engine.onStall();
    engine.enter(h.repo, 'plan-loop', STEP, 're-entry');
    resolve({ ok: true, paths: [EDITED] });
    await flushGate();
    expect(readChangedTests(h.repo)).toEqual({ step: STEP, paths: [] });
  });

  it('IT-GREEN-REVIEW-stall: a stall during the probe errors the round; the late probe still completes it and records its flag (§27.12)', async () => {
    const engine = makeEngine(undefined, greenReviewFake());
    await driveGreenToReview(engine);
    const { changedTestPaths, resolve } = deferredChangedTestPaths();
    changedSinceBaseline = () => changedTestPaths({ repoDir: h.repo, baseline: OID });
    writeRoundReport(1, []);
    engine.onDoneSignal();
    engine.onStall();
    expect(readAppLoopState(h.repo)?.status).toBe('error');
    resolve({ ok: true, paths: [EDITED] });
    await flushGate();
    expect(completed(engine)).toBe(true);
    expect(readChangedTests(h.repo)).toEqual({ step: STEP, paths: [EDITED] });
  });

  it('IT-GREEN-REVIEW-dedup: a duplicate done-signal while the probe is pending does not burn a second retry attempt', async () => {
    const engine = makeEngine(undefined, greenReviewFake());
    await driveGreenToReview(engine);
    const report = roundReportFile(h.repo, 1)!;
    mkdirSync(dirname(report), { recursive: true });
    writeFileSync(report, '# incomplete — a persona is missing\n');
    engine.onDoneSignal();
    engine.onDoneSignal();
    await flushGate();
    expect(h.emitError).not.toHaveBeenCalled();
  });

  it('IT-GREEN-REVIEW-plain: a non-GREEN loop review round runs no probe and records no flag', async () => {
    const engine = makeEngine(undefined, makeFakeCompletionPredicates({ changedTestPaths: async () => ({ ok: true, paths: [EDITED] }) }));
    seedBaseline();
    driveToReviewInjected(engine);
    writeRoundReport(1, []);
    engine.onDoneSignal();
    await flushGate();
    expect(completed(engine)).toBe(true);
    expect(readChangedTests(h.repo)).toBeNull();
  });
});

describe('§27.3 — the loop brief reaches both the work turn and the review-and-fix turn', () => {
  const BRIEF_PATH = '/tiers/plan-loop/prompts/brief.md';
  const BRIEF_TEXT = 'No acceptance criterion may be deferred.';
  const readRecipe = (p: string): string => (p === BRIEF_PATH ? BRIEF_TEXT : '# work turn\nProduce the plan.');

  it('injects the brief into the work prompt and into the review prompt after the context is cleared', () => {
    h.defResult = resolved({ ...fileDef(), brief: BRIEF_PATH });
    const engine = makeEngine(undefined, undefined, undefined, { readRecipe });
    enterAndInjectWork(engine);
    const workPrompt = h.injected[h.injected.length - 1];
    expect(workPrompt).toContain('Produce the plan.');
    expect(workPrompt).toContain(BRIEF_TEXT);
    writeArtifact(true);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
    const reviewPrompt = h.injected[h.injected.length - 1];
    expect(reviewPrompt).toContain('review-and-fix');
    expect(reviewPrompt).toContain(BRIEF_TEXT);
  });

  it('composes no review-and-fix prompt when the brief cannot be read by the time the round starts', () => {
    h.defResult = resolved({ ...fileDef(), brief: BRIEF_PATH });
    let briefReadable = true;
    const engine = makeEngine(undefined, undefined, undefined, { readRecipe: (p) => (p === BRIEF_PATH && !briefReadable ? null : readRecipe(p)) });
    enterAndInjectWork(engine);
    writeArtifact(true);
    briefReadable = false;
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected.some((t) => t.includes('review-and-fix'))).toBe(false);
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'error', errorReason: expect.stringContaining('could not compose prompt') });
  });

  it('composes no prompt when the declared brief cannot be read', () => {
    h.defResult = resolved({ ...fileDef(), brief: BRIEF_PATH });
    const engine = makeEngine(undefined, undefined, undefined, { readRecipe: (p) => (p === BRIEF_PATH ? null : readRecipe(p)) });
    enterAndInjectWork(engine);
    expect(h.injected.some((t) => t.includes('Produce the plan.'))).toBe(false);
  });
});

describe('§27.4 — the reviewer hand-off names the impl-slice a phase loop is reviewing', () => {
  it('a refactor round on slice 3 tells the reviewers it covers impl-slice 3', () => {
    h.defResult = resolved(refactorDef());
    const engine = makeEngine();
    h.currentSliceResult = 3;
    driveToReviewInjected(engine);
    expect(h.injected[h.injected.length - 1]).toContain('impl-slice 3 of the plan only');
  });

  it('a loop that is not a TDD phase names no slice', () => {
    h.defResult = resolved(fileDef());
    const engine = makeEngine();
    h.currentSliceResult = 3;
    driveToReviewInjected(engine);
    expect(h.injected[h.injected.length - 1]).not.toContain('impl-slice 3');
  });
});
