import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppLoopEngine, type AppLoopEngineDeps } from '../../src/main/appLoopEngine';
import { readAppLoopState, roundReportFile, roundReportRel, writeAppLoopState, type AppLoopRunState } from '../../src/main/appLoopState';
import { completionMarker } from '../../src/main/appWorkTurn';
import { exampleRoundReport } from '../../src/shared/roundReport';
import type { HostedAgentState } from '../../src/main/loopOrchestrator';
import type { LoopDefV2, LoopDefV2Result } from '../../src/main/loopDefV2';

// §27.3/§27.12 — the §27 work-turn engine, driven at its observable boundary with REAL fs (the run-state
// file, the completion artifact) and its domain ports as controllable fakes (hostedAgent injectability, the
// stall timer, the injector). The engine reuses the §26 turn state machine (loopOrchestrator) for the
// in-flight mechanics; these tests grade the §27-specific behavior: boundary-then-work injection, the
// artifact-marker completion gate, retry-once-then-error, stall→error without a kill, the identity-carrying
// route-out, and resume that never re-drives a stopped or completed turn.

const STEP = 'plan';
const TURN_KEY = 'work-plan';
const REVIEW_KEY = 'review-plan';
const ROSTER = ['review-plan-principal', 'review-plan-security'];
const FIXED = (): Date => new Date('2026-07-17T12:00:00.000Z');

let repo: string;
let artifactPath: string;
let hosted: HostedAgentState;
let injected: string[];
let deps: AppLoopEngineDeps;
let audit: Mock<(repoDir: string, cmd: string, exit: number | null) => void>;
let emitError: Mock<(reason: string) => void>;
let terminateFlow: Mock<(repoDir: string) => void>;
let armTimer: Mock<() => void>;
let cancelTimer: Mock<() => void>;
let readArtifact: Mock<(p: string) => string | null>;

/** A file-producing plan-loop def whose completion artifact resolves under the repo's §27 area, declaring a
 *  two-persona reviewer catalog and a compact pre-review boundary so the review-and-fix chain (N3) is real. */
function fileDef(): LoopDefV2 {
  return {
    version: 'v2',
    name: 'plan-loop',
    origin: 'app-bundled',
    work: { recipe: join(repo, 'recipe', 'work.md'), artifact: 'plan' },
    reviewers: [
      { persona: ROSTER[0], charter: join(repo, 'charter', 'principal.md'), tools: ['Read'] },
      { persona: ROSTER[1], charter: join(repo, 'charter', 'security.md'), tools: ['Read', 'Bash'] },
    ],
    consolidator: join(repo, 'recipe', 'consolidate.md'),
    boundaries: [
      { boundary: 'pre-work', mode: 'clear' },
      { boundary: 'pre-review', mode: 'compact', message: 'Keep the plan and the ticket.' },
    ],
    report: { sections: ['summary'] },
    gate: [{ option: 'approve', sideEffects: [] }],
    pickup: { initialStatus: 'planning', branchTemplate: 'plan-loop/issue-{issue}' },
    inputs: [],
    outputs: [{ id: 'plan', path: artifactPath }],
    exec: null,
  };
}

/** A commit-producing def: its work artifact id has no output binding → done-signal alone. */
function commitDef(): LoopDefV2 {
  return { ...fileDef(), work: { recipe: join(repo, 'recipe', 'work.md'), artifact: 'commits' }, outputs: [] };
}

let defResult: LoopDefV2Result;
function makeEngine(persistOverride?: (repoDir: string, state: AppLoopRunState) => void): ReturnType<typeof createAppLoopEngine> {
  audit = vi.fn();
  emitError = vi.fn();
  terminateFlow = vi.fn();
  armTimer = vi.fn();
  cancelTimer = vi.fn();
  injected = [];
  readArtifact = vi.fn((p: string) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  });
  deps = {
    inject: (text) => injected.push(text),
    hostedAgent: () => hosted,
    armTimer,
    cancelTimer,
    noteSettle: () => {},
    resolveDef: () => defResult,
    readRecipe: () => '# work turn\nProduce the plan.',
    readArtifact: (p) => readArtifact(p),
    persist: persistOverride ?? ((repoDir, state) => writeAppLoopState(repoDir, state, FIXED)),
    audit,
    emitError,
    onViewChanged: () => {},
    terminateFlow,
    resolveReportLocation: (repoDir, round) => {
      const abs = roundReportFile(repoDir, round);
      return abs ? { abs, rel: roundReportRel(round) } : null;
    },
  };
  return createAppLoopEngine(deps);
}

/** A well-formed round-1 report accounting for the def's roster and its single section. */
function writeReport(content = exampleRoundReport({ sections: ['summary'], roster: ROSTER })): void {
  const p = roundReportFile(repo, 1)!;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** Enter → complete the WORK turn → drain the pre-review boundary → the review-and-fix prompt injects. */
function driveToReviewInjected(engine: ReturnType<typeof createAppLoopEngine>): void {
  enterAndInjectWork(engine);
  writeArtifact(true);
  engine.onDoneSignal(); // work completes → chains the review-and-fix turn (§27.3)
  engine.onInjectable(); // the pre-review boundary drains + the instance re-quiesces
  engine.onInjectable(); // the review-and-fix prompt injects
}

/** Drive enter → boundary drains → work prompt injects (hosted idle throughout). */
function enterAndInjectWork(engine: ReturnType<typeof createAppLoopEngine>): void {
  engine.enter(repo, 'plan-loop', STEP);
  engine.onInjectable(); // the boundary command drained + the instance re-quiesced
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'appengine-'));
  mkdirSync(join(repo, 'recipe'), { recursive: true });
  writeFileSync(join(repo, 'recipe', 'work.md'), '# work turn\nProduce the plan.\n');
  artifactPath = join(repo, '.agent-terminal', 'loop', 'artifacts', 'plan.md');
  hosted = 'idle';
  defResult = { ok: true, def: fileDef() };
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writeArtifact(withMarker: boolean): void {
  mkdirSync(join(repo, '.agent-terminal', 'loop', 'artifacts'), { recursive: true });
  writeFileSync(artifactPath, withMarker ? `# plan\n${completionMarker(STEP)}\n` : '# plan\n(no marker)\n');
}

describe('§27 engine — entry, boundary, and the work injection (AC1, AC9)', () => {
  it('injects the declared boundary command FIRST, then the work prompt, and persists status working', () => {
    const engine = makeEngine();
    engine.enter(repo, 'plan-loop', STEP);
    expect(injected[0]).toBe('/clear'); // the def's pre-work boundary, before any work prompt
    expect(readAppLoopState(repo)).toMatchObject({ loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'working' });
    engine.onInjectable(); // boundary drained + idle-confirm
    expect(injected[1]).toContain('Produce the plan.'); // the recipe body
    expect(injected[1]).toContain(completionMarker(STEP)); // the marker instruction
    expect(injected[1]).toContain('turn-done:work-plan'); // the §27 done-signal
    expect(engine.activeTurnKey()).toBe(TURN_KEY);
    // AC9 — the boundary is recorded in the §25 audit (no round/iteration event, exit null).
    expect(audit).toHaveBeenCalledWith(repo, expect.stringContaining('/clear'), null);
  });

  it('a compact boundary issues /compact carrying the def message (§27.9)', () => {
    defResult = { ok: true, def: { ...fileDef(), boundaries: [{ boundary: 'pre-work', mode: 'compact', message: 'Keep the plan.' }] } };
    const engine = makeEngine();
    engine.enter(repo, 'plan-loop', STEP);
    expect(injected[0]).toBe('/compact Keep the plan.');
  });

  it('does not start a turn or write run-state when the def fails to resolve (AC6 handled at the view)', () => {
    defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' };
    const engine = makeEngine();
    engine.enter(repo, 'plan-loop', STEP);
    expect(injected).toEqual([]);
    expect(readAppLoopState(repo)).toBeNull();
  });

  it('refuses a second entry while a turn is in flight (AC4 — not interleaved)', () => {
    const engine = makeEngine();
    enterAndInjectWork(engine);
    const count = injected.length;
    engine.enter(repo, 'plan-loop', STEP); // in-flight: ignored
    expect(injected.length).toBe(count);
  });
});

describe('§27 engine — work completion gate + review chain (AC2, AC3)', () => {
  it('a marker-bearing artifact completes the WORK turn and chains the pre-review boundary + review prompt (AC1)', () => {
    const engine = makeEngine();
    enterAndInjectWork(engine);
    const afterWork = injected.length;
    writeArtifact(true);
    engine.onDoneSignal(); // work done-signal → work complete, chain the review-and-fix turn (§27.3)
    engine.onInjectable(); // the pre-review boundary drains
    expect(injected[afterWork]).toBe('/compact Keep the plan and the ticket.'); // the def's pre-review boundary
    engine.onInjectable(); // the review-and-fix prompt injects
    expect(injected[afterWork + 1]).toContain(ROSTER[0]); // the roster is conveyed (AC2)
    expect(injected[afterWork + 1]).toContain(ROSTER[1]);
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'working', round: 1 });
    expect(engine.activeTurnKey()).toBe(REVIEW_KEY);
  });

  it('a def declaring no work artifact completes the work turn on the done-signal alone, then chains review (AC3)', () => {
    defResult = { ok: true, def: commitDef() };
    const engine = makeEngine();
    enterAndInjectWork(engine);
    engine.onDoneSignal(); // work completes on the done-signal → chains review
    expect(readArtifact).not.toHaveBeenCalled(); // commit-producing work turn: no artifact read
    expect(readAppLoopState(repo)?.turnKey).toBe(REVIEW_KEY); // advanced into the review turn
  });

  it('an artifact present but missing the marker triggers one retry, then error (AC3, AC5)', () => {
    const engine = makeEngine();
    enterAndInjectWork(engine);
    const afterWork = injected.length;
    writeArtifact(false); // present but no marker
    engine.onDoneSignal(); // first failure → one re-injection of the same turn
    expect(injected.length).toBe(afterWork + 1);
    expect(readAppLoopState(repo)?.status).not.toBe('error'); // not yet
    engine.onDoneSignal(); // second failure → error
    const state = readAppLoopState(repo);
    expect(state?.status).toBe('error');
    expect(state?.errorReason).toBeTruthy();
    expect(emitError).toHaveBeenCalledTimes(1);
    // AC7 — the failure is recorded in the §25 audit with its reason (exit 1).
    expect(audit).toHaveBeenCalledWith(repo, expect.stringContaining(state!.errorReason!), 1);
  });
});

describe('§27 engine — stall (AC6)', () => {
  it('a stall resolves to error without retrying and without a kill (process left alive to inspect)', () => {
    const engine = makeEngine();
    enterAndInjectWork(engine);
    const afterWork = injected.length;
    engine.onStall();
    expect(injected.length).toBe(afterWork); // NOT re-injected
    const state = readAppLoopState(repo);
    expect(state?.status).toBe('error');
    expect(state?.errorReason).toMatch(/stall/i);
    // No kill port exists on the engine — the instance's process is untouched by design.
  });

  it('visible activity re-arms the stall watchdog while in flight (a long streaming turn never stalls)', () => {
    const engine = makeEngine();
    enterAndInjectWork(engine);
    armTimer.mockClear();
    engine.noteActivity();
    engine.noteActivity();
    expect(armTimer).toHaveBeenCalledTimes(2);
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
    expect(emitError).toHaveBeenCalledTimes(1);
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
    const live = engine.liveErrorFor(repo);
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
    expect(engine.liveErrorFor(repo)).not.toBeNull(); // held after the failed error-persist
    engine.routeOut(repo, STEP, TURN_KEY, 'retry'); // transitions to `working`
    expect(engine.liveErrorFor(repo)).toBeNull(); // the non-error persist released the hold
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
    const afterError = injected.length;
    engine.routeOut(repo, STEP, TURN_KEY, 'retry');
    engine.onInjectable(); // boundary drains
    engine.onInjectable(); // work re-injects
    expect(injected.length).toBeGreaterThan(afterError);
    expect(readAppLoopState(repo)?.status).toBe('working');
  });

  it('accept advances a present artifact to complete WITHOUT re-running or injecting (AC7)', () => {
    const engine = makeEngine();
    toError(engine);
    writeArtifact(true); // the artifact is actually present
    const afterError = injected.length;
    engine.routeOut(repo, STEP, TURN_KEY, 'accept');
    expect(readAppLoopState(repo)?.status).toBe('complete');
    expect(injected.length).toBe(afterError); // never injects
  });

  it('accept with no present artifact does not advance (retry is the path)', () => {
    const engine = makeEngine();
    toError(engine);
    emitError.mockClear(); // isolate the refused-Accept call from the stall→error emit
    engine.routeOut(repo, STEP, TURN_KEY, 'accept'); // artifact absent, but the def RESOLVED
    expect(readAppLoopState(repo)?.status).toBe('error');
    expect(emitError).not.toHaveBeenCalled(); // a resolved-absent refusal is SILENT — Retry is the affordance
    expect(engine.liveErrorFor(repo)?.kind).toBe('turn-error'); // the retained stall error keeps its kind — the refusal never flips it to def-unresolvable
  });

  it('terminate moves the flow off the step', () => {
    const engine = makeEngine();
    toError(engine);
    engine.routeOut(repo, STEP, TURN_KEY, 'terminate');
    expect(terminateFlow).toHaveBeenCalledWith(repo);
  });

  it('a route-out naming a DIFFERENT turn is ignored (§6 — acts on the payload identity, not ambient)', () => {
    const engine = makeEngine();
    toError(engine);
    const afterError = injected.length;
    engine.routeOut(repo, STEP, 'work-someone-else', 'retry');
    expect(injected.length).toBe(afterError); // did not re-drive a turn it does not name
    expect(readAppLoopState(repo)?.status).toBe('error');
  });
});

describe('§27 engine — resume (AC8)', () => {
  it('reconstructs a persisted error and does NOT re-drive it; retry then acts on the right turn', () => {
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'error', errorReason: 'stalled: no terminal activity' }, FIXED);
    const engine = makeEngine();
    engine.resume(repo);
    expect(injected).toEqual([]); // an error is human-owned — never re-driven on resume
    expect(readAppLoopState(repo)?.status).toBe('error');
    engine.routeOut(repo, STEP, TURN_KEY, 'retry'); // acts on the reconstructed turn
    expect(readAppLoopState(repo)?.status).toBe('working');
  });

  it('refuses Accept after resume when the def no longer resolves — no unverified complete (CWE-754)', () => {
    // The bound def was deleted/edited between runs, so resume cannot reconstruct the real completion
    // contract. Accept must NOT mark the file-producing turn complete without validating an artifact — it
    // reconstructs an UNRESOLVED turn, and Accept refuses (Retry/Terminate remain the route out).
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'error', errorReason: 'stalled' }, FIXED);
    defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' };
    const engine = makeEngine();
    engine.resume(repo);
    engine.routeOut(repo, STEP, TURN_KEY, 'accept');
    expect(readAppLoopState(repo)?.status).toBe('error'); // Accept refused: not fabricated complete
    expect(injected).toEqual([]); // and never injected
  });

  it('surfaces a def-unresolvable error when Accept is refused on an unresolved resumed turn (CWE-755)', () => {
    // Refusing Accept silently leaves the operator staring at the stale ORIGINAL error reason (e.g. `stall`)
    // with an Accept affordance that can never succeed and no feedback saying so. The refusal must surface a
    // def-unresolvable reason via emitError (and update the live error) so the view tells the operator to
    // retry or terminate — the exceptional condition is detected AND reported, not just detected.
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'error', errorReason: 'stalled' }, FIXED);
    defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' };
    const engine = makeEngine();
    engine.resume(repo);
    engine.routeOut(repo, STEP, TURN_KEY, 'accept');
    expect(readAppLoopState(repo)?.status).toBe('error'); // still not fabricated complete
    expect(engine.liveErrorFor(repo)?.kind).toBe('def-unresolvable'); // structured kind, not a message-token match — wording is free to change
    expect(emitError).toHaveBeenCalledWith(engine.liveErrorFor(repo)?.reason); // the surfaced push equals the live reason, whatever its wording
  });

  it('never re-runs a completed turn on resume', () => {
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'complete' }, FIXED);
    const engine = makeEngine();
    engine.resume(repo);
    expect(injected).toEqual([]);
    expect(readAppLoopState(repo)?.status).toBe('complete');
  });
});

describe('§27 engine — the review-and-fix turn (AC3, AC4, AC5, AC7)', () => {
  it('completes only on the done-file + a well-formed report at the round-keyed location (AC3, AC7)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    const afterReviewPrompt = injected.length;
    engine.onDoneSignal(); // done-signal but NO report yet → not well-formed → one retry
    expect(readAppLoopState(repo)?.status).not.toBe('complete');
    expect(injected.length).toBe(afterReviewPrompt + 1); // re-injected once
    writeReport(); // a well-formed report accounting for the full roster, at reports/1.md
    expect(existsSync(roundReportFile(repo, 1)!)).toBe(true);
    engine.onDoneSignal(); // done-signal + well-formed report → complete
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'complete', round: 1 });
  });

  it('a report OMITTING a roster persona is malformed → one re-injection then error (AC4)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    const afterReviewPrompt = injected.length;
    writeReport(exampleRoundReport({ sections: ['summary'], roster: [ROSTER[0]] })); // omits ROSTER[1]
    engine.onDoneSignal(); // first malformed → re-inject
    expect(injected.length).toBe(afterReviewPrompt + 1);
    expect(readAppLoopState(repo)?.status).not.toBe('error');
    engine.onDoneSignal(); // second malformed → error
    const state = readAppLoopState(repo);
    expect(state).toMatchObject({ turnKey: REVIEW_KEY, status: 'error', round: 1 });
    expect(state?.errorReason).toBeTruthy();
    expect(emitError).toHaveBeenCalled();
    // AC8 — the review-round error is recorded in the §25 audit with its reason (exit 1).
    expect(audit).toHaveBeenCalledWith(repo, expect.stringContaining(state!.errorReason!), 1);
  });

  it('a report that does not parse against the declared structure is malformed → error (AC4)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    writeReport('nonsense with no sections and no persona records\n'); // missing the `summary` section
    engine.onDoneSignal();
    engine.onDoneSignal();
    expect(readAppLoopState(repo)?.status).toBe('error');
  });

  it('a report accounting for a persona that recorded nothing (empty marker) still completes (AC5)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    // exampleRoundReport gives ROSTER[1] only the empty marker — a present-empty persona. It completes.
    writeReport();
    engine.onDoneSignal();
    expect(readAppLoopState(repo)?.status).toBe('complete');
  });

  it('audits the review-round boundary and completion with the review-round vocabulary (§25 wiring, AC3)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine); // work complete → cross the pre-review boundary → inject the review prompt
    expect(audit).toHaveBeenCalledWith(repo, expect.stringContaining('review round 1 boundary'), null);
    writeReport();
    engine.onDoneSignal();
    expect(readAppLoopState(repo)?.status).toBe('complete');
    expect(audit).toHaveBeenCalledWith(repo, expect.stringContaining('review round 1 complete'), 0);
  });

  it('audits a review-round error and retry with the review-round vocabulary, never the work-turn string (§25 wiring, AC4/AC8)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    writeReport(exampleRoundReport({ sections: ['summary'], roster: [ROSTER[0]] })); // omits ROSTER[1] → malformed
    engine.onDoneSignal();
    engine.onDoneSignal(); // → review error
    expect(audit).toHaveBeenCalledWith(repo, expect.stringContaining('review round 1 failed'), 1);
    engine.routeOut(repo, STEP, REVIEW_KEY, 'retry');
    expect(audit).toHaveBeenCalledWith(repo, expect.stringContaining('review round 1 retry'), null);
  });

  it('the report is never read for a review turn whose report location cannot be resolved → cannot complete', () => {
    const engine = makeEngine();
    // resolveReportLocation returns null (e.g. a planted symlink at the loop area): the review turn errors
    // rather than fabricating a pass on an unreadable report.
    deps.resolveReportLocation = () => null;
    enterAndInjectWork(engine);
    writeArtifact(true);
    engine.onDoneSignal(); // work completes → chain review, but the location is unresolvable
    expect(readAppLoopState(repo)?.status).toBe('error');
    expect(readAppLoopState(repo)?.turnKey).toBe(REVIEW_KEY);
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
    const malformed = readFileSync(roundReportFile(repo, 1)!, 'utf8');
    const afterError = injected.length;
    engine.routeOut(repo, STEP, REVIEW_KEY, 'accept');
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'complete', round: 1 });
    expect(injected.length).toBe(afterError); // never re-injected — the malformed report was NOT re-generated
    expect(readFileSync(roundReportFile(repo, 1)!, 'utf8')).toBe(malformed); // the report is kept, malformation included
    // AC8 — the override is recorded in the §25 audit with the review-round vocabulary (§25 wiring): a bare
    // `accept` substring is vacuous here (the work-turn accept literal also carries it), so pin `review round N`.
    expect(audit).toHaveBeenCalledWith(repo, expect.stringContaining('review round 1 accepted'), 0);
  });

  it('accept does NOT require a well-formed report (the override diverges from the work turn\'s artifact-gated accept)', () => {
    const engine = makeEngine();
    toReviewError(engine);
    // The report on disk is malformed and stays malformed; accept still advances (the human backstop).
    engine.routeOut(repo, STEP, REVIEW_KEY, 'accept');
    expect(readAppLoopState(repo)?.status).toBe('complete');
  });

  it('accept REFUSES an UNRESOLVED review round reached via a report-location failure — never fabricates a finalized round (CWE-754/755)', () => {
    // An `unresolved` review turn (the loop area/def no longer resolves) has NO report to keep, so the AC8
    // override has nothing to finalize; accept must refuse it exactly as the work-turn def-unresolvable guard
    // does, not persist `complete` over an empty round. Reached here by chaining review when the report
    // location is unresolvable (startReview's unresolved fallback).
    const engine = makeEngine();
    deps.resolveReportLocation = () => null;
    enterAndInjectWork(engine);
    writeArtifact(true);
    engine.onDoneSignal(); // work completes → chain review, but the location is unresolvable → unresolved review error
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'error' });
    const afterError = injected.length;
    engine.routeOut(repo, STEP, REVIEW_KEY, 'accept');
    expect(readAppLoopState(repo)?.status).toBe('error'); // refused — NOT fabricated complete
    expect(injected.length).toBe(afterError); // and never re-injected
  });

  it('accept REFUSES an UNRESOLVED review round reconstructed on resume (def deleted) and surfaces def-unresolvable (CWE-755)', () => {
    // The def was deleted/edited between runs; resume reconstructs an `unresolved` review turn. Accepting it
    // would finalize the round `complete` with reportPath === '' and no report — violating AC7 (one immutable
    // report per finalized round) and AC8 (accept keeps THE malformed report; here there is none). The guard
    // must refuse and surface a def-unresolvable reason so Retry/Terminate are the route out.
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'error', errorReason: 'report omits a roster persona', round: 1 }, FIXED);
    defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' };
    const engine = makeEngine();
    engine.resume(repo);
    engine.routeOut(repo, STEP, REVIEW_KEY, 'accept');
    expect(readAppLoopState(repo)?.status).toBe('error'); // still not fabricated complete
    expect(engine.liveErrorFor(repo)?.kind).toBe('def-unresolvable'); // structured kind — wording free to change
    expect(emitError).toHaveBeenCalledWith(engine.liveErrorFor(repo)?.reason);
  });

  it('retry re-enters the same review-and-fix turn of the correct round (boundary + review prompt)', () => {
    const engine = makeEngine();
    toReviewError(engine);
    const afterError = injected.length;
    engine.routeOut(repo, STEP, REVIEW_KEY, 'retry');
    engine.onInjectable(); // pre-review boundary drains
    engine.onInjectable(); // review prompt re-injects
    expect(injected.length).toBeGreaterThan(afterError);
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'working', round: 1 });
  });

  it('terminate moves the flow off the step', () => {
    const engine = makeEngine();
    toReviewError(engine);
    engine.routeOut(repo, STEP, REVIEW_KEY, 'terminate');
    expect(terminateFlow).toHaveBeenCalledWith(repo);
  });
});

describe('§27 engine — review-turn resume (AC9)', () => {
  it('reconstructs a stopped review turn (round + turnKey), never re-drives it, and retry acts on it', () => {
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'error', errorReason: 'report omits a roster persona', round: 1 }, FIXED);
    const engine = makeEngine();
    engine.resume(repo);
    expect(injected).toEqual([]); // human-owned — never re-driven on resume
    expect(engine.liveErrorFor(repo)).toMatchObject({ step: STEP, turnKey: REVIEW_KEY });
    engine.routeOut(repo, STEP, REVIEW_KEY, 'retry'); // acts on the reconstructed review turn of round 1
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'working', round: 1 });
  });

  it('accept on a resumed review error keeps the malformed report and completes without re-running (AC8, AC9)', () => {
    writeReport(exampleRoundReport({ sections: ['summary'], roster: [ROSTER[0]] })); // a malformed report is on disk
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'error', errorReason: 'malformed', round: 1 }, FIXED);
    const engine = makeEngine();
    engine.resume(repo);
    engine.routeOut(repo, STEP, REVIEW_KEY, 'accept');
    expect(readAppLoopState(repo)?.status).toBe('complete');
    expect(injected).toEqual([]); // never injected on the accept override
  });

  it('never re-runs a completed review turn on resume', () => {
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'complete', round: 1 }, FIXED);
    const engine = makeEngine();
    engine.resume(repo);
    expect(injected).toEqual([]);
    expect(readAppLoopState(repo)?.status).toBe('complete');
  });
});
