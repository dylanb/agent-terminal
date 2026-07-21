import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppLoopEngine, type AppLoopEngineDeps } from '../../src/main/appLoopEngine';
import { provideAppLoopView } from '../../src/main/loopViewV2';
import {
  armInterrupt,
  clearPolish,
  consolidatorOutputFile,
  consolidatorOutputRel,
  enterPolish,
  readAppLoopState,
  readArmedInterrupt,
  readPolish,
  roundReportFile,
  roundReportRel,
  writeAppLoopState,
  type AppLoopRunState,
} from '../../src/main/appLoopState';
import { completionMarker } from '../../src/main/appWorkTurn';
import { exampleRoundReport, REPORT_GRAMMAR } from '../../src/shared/roundReport';
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
const CONSOLIDATE_KEY = 'consolidate-plan';
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
/** The step a polish stand-down is active for (§27.9/AC6) — the engine consults it per decision, keyed on the
 *  decision's step exactly as the view is, so a stand-down for one step never suppresses another's levers. Set
 *  per-test; null (no stand-down) so the ordinary drive helpers inject as before. */
let polishStep: string | null;

/** When set, the engine's `clearPolish` dep throws this message — models a hostile on-disk state (polish.yaml
 *  swapped for a directory → EISDIR that rmSync's `force` does not swallow). Null (no throw) by default. */
let clearPolishError: string | null;

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
      { boundary: 'pre-consolidate', mode: 'compact', message: 'Keep the two round reports.' },
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
  polishStep = null;
  clearPolishError = null;
  readArtifact = vi.fn((p: string) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  });
  deps = {
    inject: (text) => injected.push(text),
    polishActive: (_repoDir, step) => polishStep === step,
    clearPolish: (r) => {
      if (clearPolishError) throw new Error(clearPolishError);
      clearPolish(r);
    },
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
    resolveConsolidatorLocation: (repoDir, round) => {
      const abs = consolidatorOutputFile(repoDir, round);
      return abs ? { abs, rel: consolidatorOutputRel(round) } : null;
    },
  };
  return createAppLoopEngine(deps);
}

/** Write a well-formed round-N report; `failed` names personas recorded as failed-to-run (§27.5/AC7). */
function writeRoundReport(round: number, failed: string[] = []): void {
  const g = REPORT_GRAMMAR;
  const parts = ['## summary', ''];
  for (const persona of ROSTER) {
    parts.push(`### ${persona}`, '', failed.includes(persona) ? g.failedMarker : g.emptyMarker, '');
  }
  const p = roundReportFile(repo, round)!;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${parts.join('\n')}\n`);
}

function writeConsolidatorOutput(round: number, content: string): void {
  const p = consolidatorOutputFile(repo, round)!;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** Drive work → review round 1 → the consolidator prompt injected (report is well-formed, `failed` optional). */
function driveToConsolidateInjected(engine: ReturnType<typeof createAppLoopEngine>, failed: string[] = []): void {
  driveToReviewInjected(engine);
  writeRoundReport(1, failed);
  engine.onDoneSignal(); // review completes → chains the consolidator turn (§27.6)
  engine.onInjectable(); // the pre-consolidate boundary drains
  engine.onInjectable(); // the consolidator prompt injects
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
  it('completes only on the done-file + a well-formed report at the round-keyed location, then chains the consolidator (AC1, AC3)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    const afterReviewPrompt = injected.length;
    engine.onDoneSignal(); // done-signal but NO report yet → not well-formed → one retry
    expect(readAppLoopState(repo)?.status).not.toBe('complete');
    expect(injected.length).toBe(afterReviewPrompt + 1); // re-injected once
    writeReport(); // a well-formed report accounting for the full roster, at reports/1.md
    expect(existsSync(roundReportFile(repo, 1)!)).toBe(true);
    engine.onDoneSignal(); // done-signal + well-formed report → the review round completes and chains the consolidator (§27.6/N4)
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'working', round: 1 });
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

  it('a report accounting for a persona that recorded nothing (empty marker) still completes the round and chains the consolidator (AC5)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    // exampleRoundReport gives ROSTER[1] only the empty marker — a present-empty persona. The round completes.
    writeReport();
    engine.onDoneSignal();
    expect(readAppLoopState(repo)?.turnKey).toBe(CONSOLIDATE_KEY); // review complete → consolidator chains
  });

  it('audits the review-round boundary and completion with the review-round vocabulary (§25 wiring, AC3)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine); // work complete → cross the pre-review boundary → inject the review prompt
    expect(audit).toHaveBeenCalledWith(repo, expect.stringContaining('review round 1 boundary'), null);
    writeReport();
    engine.onDoneSignal();
    // The review round completes (audited) and chains the consolidator (§27.6/N4) rather than halting.
    expect(audit).toHaveBeenCalledWith(repo, expect.stringContaining('review round 1 complete'), 0);
    expect(readAppLoopState(repo)?.turnKey).toBe(CONSOLIDATE_KEY);
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

  it('accept REFUSES a review round whose report was NEVER written — present is the one precondition the override keeps (§27.12c/CWE-754)', () => {
    // The fixer wrote its done-file but no report (a real §27.15 "writes nothing" state): retry-then-error with
    // NOTHING on disk. The AC8 override keeps a present-but-MALFORMED report; there is none here, so accept must
    // refuse — finalizing `complete` would record a round with no auditable report at all (§27.5), the exact
    // fabricated-completion the §27.12c "artifact actually present" precondition forbids.
    const engine = makeEngine();
    driveToReviewInjected(engine);
    engine.onDoneSignal(); // no report → one retry
    engine.onDoneSignal(); // still no report → review error, report absent
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'error', round: 1 });
    expect(existsSync(roundReportFile(repo, 1)!)).toBe(false);
    const afterError = injected.length;
    const emitsBeforeAccept = emitError.mock.calls.length;
    engine.routeOut(repo, STEP, REVIEW_KEY, 'accept');
    expect(readAppLoopState(repo)?.status).toBe('error'); // refused — NOT fabricated complete
    expect(injected.length).toBe(afterError); // and never re-injected
    // the accept click itself surfaces a FRESH error emission (not merely the earlier drive-to-error one), so
    // Retry/Terminate stay the route out — a count increment, since the reason prose is free to change and the
    // drive already left a same-kind live error standing (asserting kind/reason alone would be vacuous).
    expect(emitError.mock.calls.length).toBeGreaterThan(emitsBeforeAccept);
    expect(engine.liveErrorFor(repo)?.kind).toBe('turn-error');
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

/** Complete an in-flight consolidator turn of `round` by writing its output and firing the done-signal. */
function completeConsolidate(engine: ReturnType<typeof createAppLoopEngine>, round: number, output: string): void {
  writeConsolidatorOutput(round, output);
  engine.onDoneSignal();
}

/** From an in-flight review round `round` (just chained, awaiting injectable): drive the review prompt, land
 *  a well-formed report (optionally with `failed` lenses), and drive into the consolidator prompt injected. */
function advanceReviewToConsolidateInjected(engine: ReturnType<typeof createAppLoopEngine>, round: number, failed: string[] = []): void {
  engine.onInjectable(); // pre-review boundary drains
  engine.onInjectable(); // review prompt injects
  writeRoundReport(round, failed);
  engine.onDoneSignal(); // review round completes → chains the consolidator
  engine.onInjectable(); // pre-consolidate boundary drains
  engine.onInjectable(); // consolidator prompt injects
}

describe('§27 engine — the consolidator turn chains after review (AC1)', () => {
  it('crosses the pre-consolidate boundary and injects the consolidator prompt on its own — no human action', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine);
    writeRoundReport(1);
    const afterReview = injected.length;
    engine.onDoneSignal(); // review completes → chain the consolidator
    engine.onInjectable(); // pre-consolidate boundary drains
    expect(injected[afterReview]).toBe('/compact Keep the two round reports.'); // the def's pre-consolidate boundary
    engine.onInjectable(); // consolidator prompt injects
    expect(injected[afterReview + 1]).toContain('consolidator'); // the consolidate recipe/instruction
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'working', round: 1 });
    expect(engine.activeTurnKey()).toBe(CONSOLIDATE_KEY);
    expect(audit).toHaveBeenCalledWith(repo, expect.stringContaining('consolidate'), null);
  });
});

describe('§27 engine — the consolidator completion gate (AC3)', () => {
  it('advances only on the done-file AND a well-formed verdict; malformed output retries once then errors', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    const afterConsolidate = injected.length;
    writeConsolidatorOutput(1, 'no verdict here\n'); // malformed: no verdict
    engine.onDoneSignal(); // first malformed → one re-injection
    expect(injected.length).toBe(afterConsolidate + 1);
    expect(readAppLoopState(repo)?.status).not.toBe('error');
    engine.onDoneSignal(); // second malformed → error
    const state = readAppLoopState(repo);
    expect(state).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'error', round: 1 });
    expect(state?.errorReason).toBeTruthy();
    expect(emitError).toHaveBeenCalled();
  });

  it('an `another round` naming a persona outside the catalog is malformed → error (§27.4)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, 'verdict: another round\nroster: ghost-persona\n');
    completeConsolidate(engine, 1, 'verdict: another round\nroster: ghost-persona\n');
    expect(readAppLoopState(repo)?.status).toBe('error');
  });

  it('an `another round` with an empty roster is malformed → error (a round must run someone)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, 'verdict: another round\nroster:\n');
    completeConsolidate(engine, 1, 'verdict: another round\nroster:\n');
    expect(readAppLoopState(repo)?.status).toBe('error');
  });

  it('a terminal verdict needs no roster — `clean` completes and routes to the gate (AC3, AC5)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, 'verdict: clean\n');
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'complete', round: 1, verdict: 'clean' });
  });
});

describe('§27 engine — the verdict drives the branch (AC4, AC5, AC6)', () => {
  it('`another round` returns to a review-and-fix round over EXACTLY the chosen roster (AC4)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    const afterConsolidate = injected.length;
    completeConsolidate(engine, 1, `verdict: another round\nroster: ${ROSTER[0]}\n`); // subset: principal only
    engine.onInjectable(); // pre-review boundary drains
    engine.onInjectable(); // the round-2 review prompt injects
    const prompt = injected[injected.length - 1];
    expect(prompt).toContain(ROSTER[0]); // the chosen persona is in the round-2 roster
    expect(prompt).not.toContain(ROSTER[1]); // the un-chosen persona is NOT
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'working', round: 2, chosenRoster: [ROSTER[0]] });
    expect(injected.length).toBeGreaterThan(afterConsolidate);
  });

  it('`clean` on a no-change round routes to the gate; the panel-facing state carries the verdict (AC5, AC6)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, 'verdict: clean\n');
    expect(readAppLoopState(repo)).toMatchObject({ status: 'complete', verdict: 'clean' });
  });

  it('`stop for a human` routes to the gate carrying the consolidator reason (AC5)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, 'verdict: stop for a human\nreason: the reviewers disagree on the API shape\n');
    expect(readAppLoopState(repo)).toMatchObject({ status: 'complete', verdict: 'stop for a human', verdictReason: 'the reviewers disagree on the API shape' });
  });

  it('the engine routes on the EMITTED verdict and does not recompute cleanness — `another round` on a fixed round loops (AC6)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, `verdict: another round\nroster: ${ROSTER.join(', ')}\n`);
    expect(readAppLoopState(repo)?.turnKey).toBe(REVIEW_KEY); // looped back, not gated
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
    expect(engine.liveErrorFor(repo)).not.toBeNull(); // the human is summoned even though the write failed
    expect(engine.liveErrorFor(repo)).toMatchObject({ kind: 'turn-error', step: STEP, turnKey: CONSOLIDATE_KEY });
    expect(emitError).toHaveBeenCalled(); // pushed so the panel renders the retry/terminate route-out
  });

  it('a finish-time output read that vanishes AFTER the gate accepted it falls back to `stop for a human` — never a silent `clean` (§27.6 race)', () => {
    // The completion gate reads the output as well-formed (`clean`), then a race (truncation, an unlink, a
    // planted-symlink swap) makes the finish re-read return null. finishConsolidate must fall to the SAFE side —
    // route to the gate as `stop for a human`, summoning the human — and MUST NOT advance a silent `clean` round
    // on a verdict it can no longer read.
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    writeConsolidatorOutput(1, 'verdict: clean\n');
    readArtifact.mockImplementationOnce(() => 'verdict: clean\n').mockImplementationOnce(() => null);
    engine.onDoneSignal();
    const state = readAppLoopState(repo);
    expect(state).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'complete', verdict: 'stop for a human' });
    expect(state?.verdict).not.toBe('clean');
  });

  it('there is no iteration cap — a run that keeps emitting `another round` keeps iterating (AC10)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, `verdict: another round\nroster: ${ROSTER.join(', ')}\n`);
    advanceReviewToConsolidateInjected(engine, 2);
    completeConsolidate(engine, 2, `verdict: another round\nroster: ${ROSTER.join(', ')}\n`);
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: REVIEW_KEY, round: 3 }); // round 3, still no cap
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
    expect(readAppLoopState(repo)).toMatchObject({ status: 'complete', round: 1, verdict: 'clean' });
    const afterGate = injected.length;
    engine.requestChanges(repo, STEP, CONSOLIDATE_KEY, FEEDBACK);
    engine.onInjectable(); // the pre-review boundary drains
    engine.onInjectable(); // the round-2 review prompt injects
    const prompt = injected[injected.length - 1];
    expect(injected.length).toBeGreaterThan(afterGate);
    expect(prompt).toContain(FEEDBACK); // the feedback rides the next review round (§27.9)
    expect(prompt).toContain(ROSTER[0]); // …alongside the reviewers' findings (full catalog: fresh eyes)
    expect(prompt).toContain(ROSTER[1]);
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'working', round: 2, feedback: FEEDBACK });
  });

  it('runs no consolidator and no work turn — it is the narrow, incremental lever (§27.9)', () => {
    const engine = makeEngine();
    driveToGate(engine);
    engine.requestChanges(repo, STEP, CONSOLIDATE_KEY, FEEDBACK);
    engine.onInjectable();
    engine.onInjectable();
    const prompt = injected[injected.length - 1];
    expect(prompt).toContain('review-and-fix'); // it is a review round…
    expect(prompt).not.toContain('Produce the plan'); // …never the work turn (§27.9 redo is a separate lever)
  });

  it('is inert for a decision naming a different step (§6/AC7)', () => {
    const engine = makeEngine();
    driveToGate(engine);
    const before = injected.length;
    engine.requestChanges(repo, 'implement', CONSOLIDATE_KEY, FEEDBACK);
    expect(injected.length).toBe(before);
    expect(readAppLoopState(repo)).toMatchObject({ status: 'complete', round: 1 }); // unchanged, still at the gate
  });

  it('is inert when the run is not AT a gate (no verdict reached)', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine); // an in-flight review turn — status working, no verdict
    const before = injected.length;
    engine.requestChanges(repo, STEP, REVIEW_KEY, FEEDBACK);
    expect(injected.length).toBe(before);
    expect(readAppLoopState(repo)).toMatchObject({ status: 'working' });
  });

  it('a Retry after a relaunch re-injects the persisted feedback rather than dropping the human input', () => {
    const engine = makeEngine();
    driveToGate(engine);
    engine.requestChanges(repo, STEP, CONSOLIDATE_KEY, FEEDBACK);
    engine.onInjectable();
    engine.onInjectable(); // round-2 review prompt injected; run-state persisted with feedback
    // Simulate a relaunch: a fresh engine reconstructs the stopped review turn from disk, then Retry.
    const relaunched = makeEngine();
    relaunched.resume(repo);
    relaunched.routeOut(repo, STEP, REVIEW_KEY, 'retry');
    relaunched.onInjectable();
    relaunched.onInjectable();
    expect(injected[injected.length - 1]).toContain(FEEDBACK); // the feedback survived the relaunch
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
    expect(readAppLoopState(repo)).toMatchObject({ status: 'complete', round: 1, verdict: 'clean' });
    const before = injected.length;
    expect(engine.redo(repo, STEP, CONSOLIDATE_KEY, INSTRUCTION)).toBe(true);
    // Drain the boundary + work injection (the §26 runner's settle state is path-dependent, so drain generously
    // and read the re-injected prompt out of the batch rather than a fixed index).
    engine.onInjectable();
    engine.onInjectable();
    const since = injected.slice(before);
    expect(since).toContain('/clear'); // re-enters after the def's pre-work boundary (clean slate)
    const prompt = since.find((p) => p.includes('Produce the plan.')); // the work recipe (ticket + plan)
    expect(prompt).toBeDefined();
    expect(prompt).toContain(INSTRUCTION); // the operator's instruction rides along
    expect(since.some((p) => p.includes(ROSTER[0]))).toBe(false); // NO reviewers/findings — no round history
    expect(since.some((p) => p.includes('review-and-fix'))).toBe(false);
    // the work turn is active again, carrying the instruction and NO round/feedback (a fresh work run)
    const state = readAppLoopState(repo);
    expect(state).toMatchObject({ turnKey: TURN_KEY, status: 'working', instruction: INSTRUCTION });
    expect(state?.round).toBeUndefined();
    expect(state?.feedback).toBeUndefined();
  });

  it('is the ONLY lever that re-runs the work turn — request-changes never does (§27.9)', () => {
    const engine = makeEngine();
    driveToGate(engine);
    const before = injected.length;
    engine.redo(repo, STEP, CONSOLIDATE_KEY, INSTRUCTION);
    engine.onInjectable();
    engine.onInjectable();
    expect(injected.slice(before).some((p) => p.includes('Produce the plan.'))).toBe(true); // the work recipe re-ran
  });

  it('reports true only when it re-entered; inert cases (identity, at-gate) report false so the composer holds open', () => {
    const engine = makeEngine();
    driveToGate(engine);
    const before = injected.length;
    // a decision naming a different step (§6/AC7) is inert and reports false
    expect(engine.redo(repo, 'implement', CONSOLIDATE_KEY, INSTRUCTION)).toBe(false);
    expect(injected.length).toBe(before);
    expect(readAppLoopState(repo)).toMatchObject({ status: 'complete', round: 1 }); // unchanged, still at the gate
  });

  it('is inert when the run is not AT a gate (no verdict reached), reporting false', () => {
    const engine = makeEngine();
    driveToReviewInjected(engine); // an in-flight review turn — status working, no verdict
    const before = injected.length;
    expect(engine.redo(repo, STEP, REVIEW_KEY, INSTRUCTION)).toBe(false);
    expect(injected.length).toBe(before);
    expect(readAppLoopState(repo)).toMatchObject({ status: 'working' });
  });

  it('is inert when the bound def no longer resolves — never a fabricated clean-slate run, reporting false', () => {
    const engine = makeEngine();
    driveToGate(engine);
    // §27.9/AC5 — the clean-slate work turn needs the def's recipe + completion contract; an unresolvable def
    // must be inert (return false, inject nothing, leave the gate intact), never a work run with no real backing.
    defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' };
    const before = injected.length;
    expect(engine.redo(repo, STEP, CONSOLIDATE_KEY, INSTRUCTION)).toBe(false);
    engine.onInjectable();
    engine.onInjectable();
    expect(injected.length).toBe(before); // nothing injected — no boundary, no work prompt
    expect(readAppLoopState(repo)).toMatchObject({ status: 'complete', round: 1, verdict: 'clean' }); // still at the gate
  });

  it('a Retry after a relaunch re-injects the persisted instruction rather than dropping the human input', () => {
    const engine = makeEngine();
    driveToGate(engine);
    engine.redo(repo, STEP, CONSOLIDATE_KEY, INSTRUCTION); // start persists the instruction on the work run-state
    expect(readAppLoopState(repo)?.instruction).toBe(INSTRUCTION);
    // Simulate a relaunch: a fresh engine reconstructs the stopped work turn from disk, then Retry.
    const relaunched = makeEngine();
    relaunched.resume(repo);
    relaunched.routeOut(repo, STEP, TURN_KEY, 'retry');
    relaunched.onInjectable();
    relaunched.onInjectable();
    expect(injected.some((p) => p.includes(INSTRUCTION))).toBe(true); // the instruction survived the relaunch
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
    polishStep = STEP; // the operator entered polish for this gated step; the app-owned flag is set
    const before = injected.length;
    expect(engine.requestChanges(repo, STEP, CONSOLIDATE_KEY, 'tighten the schema')).toBe(false);
    engine.onInjectable();
    engine.onInjectable();
    expect(injected.length).toBe(before); // the orchestrator stood down — no injection during polish
    expect(readAppLoopState(repo)).toMatchObject({ status: 'complete', round: 1 }); // still at the gate
  });

  it('refuses redo while polish is active — the work turn does not re-run', () => {
    const engine = makeEngine();
    driveToGate(engine);
    polishStep = STEP;
    const before = injected.length;
    expect(engine.redo(repo, STEP, CONSOLIDATE_KEY, 'start over')).toBe(false);
    engine.onInjectable();
    expect(injected.length).toBe(before);
  });

  it('the levers work again once the stand-down is cleared (approve ends polish)', () => {
    const engine = makeEngine();
    driveToGate(engine);
    polishStep = STEP;
    expect(engine.redo(repo, STEP, CONSOLIDATE_KEY, 'start over')).toBe(false); // refused during polish
    polishStep = null; // approve cleared the stand-down
    expect(engine.redo(repo, STEP, CONSOLIDATE_KEY, 'start over')).toBe(true); // the lever works again
  });

  it('a stand-down for a DIFFERENT step does not suppress this step’s levers (step-scoped, not repo-scoped)', () => {
    const engine = makeEngine();
    driveToGate(engine);
    // A polish stand-down persists for some OTHER step (e.g. entered on an earlier step, never cleared). The
    // engine keys suppression on the decision's step exactly as the view does, so this step's redo still runs.
    polishStep = 'some-other-step';
    expect(engine.redo(repo, STEP, CONSOLIDATE_KEY, 'start over')).toBe(true);
  });

  it('a fresh work-turn entry clears a stale stand-down — an abandoned polish never resurrects on re-drive', () => {
    const engine = makeEngine();
    // A prior run entered polish for this step but was Terminated (or the approve-time clear failed) rather than
    // approved, so the stand-down file persists. Re-driving the same step must start a clean cycle, not inherit it.
    enterPolish(repo, STEP);
    expect(readPolish(repo)).toEqual({ step: STEP });
    engine.enter(repo, 'plan-loop', STEP);
    expect(readPolish(repo)).toBeNull(); // the stale stand-down did not survive the fresh entry
  });

  it('a throwing clearPolish never aborts a fresh entry — the work turn still starts (best-effort cleanup)', () => {
    const engine = makeEngine();
    enterPolish(repo, STEP); // a stale stand-down exists…
    clearPolishError = 'EISDIR: illegal operation on a directory'; // …and clearing it will throw (polish.yaml is a dir)
    const before = injected.length;
    // The stale-polish clear is best-effort — a throw must NOT abort the entry, or the operator is stranded with a
    // committed step whose work turn never starts and cannot restart (re-entry would re-throw the same EISDIR).
    expect(() => engine.enter(repo, 'plan-loop', STEP)).not.toThrow();
    engine.onInjectable();
    engine.onInjectable();
    expect(injected.slice(before).some((p) => p.includes('Produce the plan.'))).toBe(true); // the work turn started anyway
    // the failed best-effort clear is recorded, never silently swallowed (§25) — the same discipline the approve
    // path pins for its own clear-polish failure.
    expect(audit).toHaveBeenCalledWith(repo, expect.stringContaining('clear-polish'), 1);
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
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: REVIEW_KEY, round: 2 });
    expect(readAppLoopState(repo)?.status).not.toBe('complete');
    expect(injected[injected.length - 1]).toContain(ROSTER[0]); // the failed lens is re-reviewed
  });

  it('a REPEAT failed lens (failed in the previous report too) stops for a human — bounding auto re-reviews to one', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine, [ROSTER[0]]); // round 1: principal failed
    completeConsolidate(engine, 1, 'verdict: clean\n'); // → forced re-review of principal
    advanceReviewToConsolidateInjected(engine, 2, [ROSTER[0]]); // round 2: principal failed AGAIN
    completeConsolidate(engine, 2, 'verdict: clean\n');
    expect(readAppLoopState(repo)).toMatchObject({ status: 'complete', verdict: 'stop for a human' });
  });

  it('a FRESH failed lens does NOT override an emitted `stop for a human` — the human-owned stop routes to the gate now (§27.6)', () => {
    // When the consolidator itself emits `stop for a human` (the loop is spinning, or a reviewer raised a
    // needs-a-human issue) AND a different lens freshly fails, the fresh-failure re-review must NOT divert the
    // human-owned stop into another autonomous round — the stop routes to the gate now, and the human decides.
    const engine = makeEngine();
    driveToConsolidateInjected(engine, [ROSTER[0]]); // round-1 report records principal failed-to-run (a fresh failure)
    completeConsolidate(engine, 1, 'verdict: stop for a human\nreason: the reviewers disagree on the API\n');
    expect(readAppLoopState(repo)).toMatchObject({ status: 'complete', verdict: 'stop for a human' });
    expect(readAppLoopState(repo)?.turnKey).toBe(CONSOLIDATE_KEY); // gated, not looped into a round-2 review
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
    expect(readAppLoopState(repo)).toMatchObject({ status: 'complete', verdict: 'clean' }); // clean honored, no failed-lens override
  });
});

describe('§27 engine — the armed interrupt routes to the gate at the next consolidate (AC9, AC11)', () => {
  it('an armed interrupt routes to the gate stating the would-be verdict, and is one-shot (cleared)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    armInterrupt(repo, STEP); // the operator arms during iteration
    completeConsolidate(engine, 1, `verdict: another round\nroster: ${ROSTER.join(', ')}\n`); // would loop back…
    // …but the armed interrupt routes to the gate instead, surfacing the would-be `another round`.
    expect(readAppLoopState(repo)).toMatchObject({ status: 'complete', verdict: 'another round' });
    expect(readAppLoopState(repo)?.turnKey).toBe(CONSOLIDATE_KEY); // stopped at the consolidator's gate, not a new review turn
    expect(readArmedInterrupt(repo)).toBeNull(); // one-shot: cleared when honored
  });

  it('with no interrupt armed the same `another round` loops back (the interrupt is the only thing that diverts it)', () => {
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, `verdict: another round\nroster: ${ROSTER.join(', ')}\n`);
    expect(readAppLoopState(repo)?.turnKey).toBe(REVIEW_KEY); // looped back — no diversion
    // §25/AC9 — a round that reaches the gate on its OWN verdict records NO interrupt-honored event, so a
    // regression emitting the interrupt event unconditionally would be caught here (the emission GATE is
    // pinned, not just the vocabulary distinctness in audit.test.ts).
    expect(audit).not.toHaveBeenCalledWith(repo, expect.stringContaining('interrupt'), expect.anything());
  });

  it('records a DISTINCT §25 interrupt-honored audit event, not the generic terminal `complete` (§25/AC9)', () => {
    // An honored armed interrupt reaches the gate by honoring a queued interrupt, not by the emitted verdict; the
    // §25 timeline must be able to tell the two apart. A run that reached the gate on its own would-be
    // `another round` would leave only a `complete` — so a distinct interrupt event must be recorded.
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    armInterrupt(repo, STEP);
    completeConsolidate(engine, 1, `verdict: another round\nroster: ${ROSTER.join(', ')}\n`);
    expect(audit).toHaveBeenCalledWith(repo, expect.stringContaining('interrupt'), expect.anything());
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
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'error', round: 1 });
    const afterError = injected.length;
    engine.routeOut(repo, STEP, CONSOLIDATE_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();
    expect(injected.length).toBeGreaterThan(afterError);
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'working', round: 1 });
  });

  it('terminate on a consolidator error moves the flow off the step', () => {
    const engine = makeEngine();
    toConsolidateError(engine);
    engine.routeOut(repo, STEP, CONSOLIDATE_KEY, 'terminate');
    expect(terminateFlow).toHaveBeenCalledWith(repo);
  });

  it('accept on a consolidator error moves off the error to the gate WITHOUT re-running (AC12)', () => {
    const engine = makeEngine();
    toConsolidateError(engine);
    const afterError = injected.length;
    engine.routeOut(repo, STEP, CONSOLIDATE_KEY, 'accept');
    expect(readAppLoopState(repo)?.status).toBe('complete');
    expect(injected.length).toBe(afterError); // never re-injected
  });

  it('resume reconstructs a stopped consolidator turn (round + turnKey), never re-drives it, and retry acts on it (AC11)', () => {
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: CONSOLIDATE_KEY, status: 'error', errorReason: 'malformed verdict', round: 2 }, FIXED);
    const engine = makeEngine();
    engine.resume(repo);
    expect(injected).toEqual([]); // human-owned — never re-driven
    expect(engine.liveErrorFor(repo)).toMatchObject({ step: STEP, turnKey: CONSOLIDATE_KEY });
    engine.routeOut(repo, STEP, CONSOLIDATE_KEY, 'retry');
    expect(readAppLoopState(repo)).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'working', round: 2 });
  });

  it('never re-runs a completed consolidator turn on resume', () => {
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: CONSOLIDATE_KEY, status: 'complete', round: 1, verdict: 'clean' }, FIXED);
    const engine = makeEngine();
    engine.resume(repo);
    expect(injected).toEqual([]);
    expect(readAppLoopState(repo)?.status).toBe('complete');
  });

  it('an interrupt armed before a relaunch is still honored at the next consolidate (AC11)', () => {
    armInterrupt(repo, STEP); // armed, then the app is relaunched
    const engine = makeEngine();
    driveToConsolidateInjected(engine);
    completeConsolidate(engine, 1, `verdict: another round\nroster: ${ROSTER.join(', ')}\n`);
    expect(readAppLoopState(repo)).toMatchObject({ status: 'complete', verdict: 'another round' }); // honored post-relaunch
    expect(readArmedInterrupt(repo)).toBeNull();
  });
});

// §27.10/§27.12/CWE-703/755 — a persisted `working` turn is DEFINITIONALLY stopped after a relaunch: its PTY
// is gone and resume never re-drives it. resume must make it routable (a live turn-error → route-out), or the
// human is never summoned and the runner sits idle forever — the exact hand-edit-to-recover strand.
describe('§27 engine — resume routes a stopped (working) turn to the human (CWE-703/755)', () => {
  it('a relaunched WORKING consolidator turn is routable — summons the human, never a silent idle', () => {
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: CONSOLIDATE_KEY, status: 'working', round: 2 }, FIXED);
    const engine = makeEngine();
    engine.resume(repo);
    expect(injected).toEqual([]); // definitionally stopped — never re-driven
    const live = engine.liveErrorFor(repo);
    expect(live).toMatchObject({ kind: 'turn-error', step: STEP, turnKey: CONSOLIDATE_KEY, round: 2 });
    engine.routeOut(repo, STEP, CONSOLIDATE_KEY, 'retry'); // the route-out is reachable
    engine.onInjectable();
    engine.onInjectable();
    expect(injected.length).toBeGreaterThan(0);
  });

  it('a relaunched WORKING review turn is routable and carries its round', () => {
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'working', round: 1 }, FIXED);
    const engine = makeEngine();
    engine.resume(repo);
    expect(injected).toEqual([]);
    expect(engine.liveErrorFor(repo)).toMatchObject({ kind: 'turn-error', step: STEP, turnKey: REVIEW_KEY, round: 1 });
  });

  it('a relaunched WORKING work turn is routable', () => {
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'working' }, FIXED);
    const engine = makeEngine();
    engine.resume(repo);
    expect(injected).toEqual([]);
    expect(engine.liveErrorFor(repo)).toMatchObject({ kind: 'turn-error', step: STEP, turnKey: TURN_KEY });
  });

  it('a relaunched COMPLETE turn is NOT re-surfaced as an error (human-owned gate, no route-out needed)', () => {
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: CONSOLIDATE_KEY, status: 'complete', round: 1, verdict: 'clean' }, FIXED);
    const engine = makeEngine();
    engine.resume(repo);
    expect(engine.liveErrorFor(repo)).toBeNull();
  });
});

// §27.12/§27.15/CWE-703/755 — the STRAND the iter-5 blocker named: after a relaunch nothing has called
// resume(), so the derived view (what the panel/strip actually render) must itself reconstruct a stopped
// turn before reading the live error. Graded at the DERIVED-VIEW boundary (provideAppLoopView over a REAL
// engine + persisted state), NOT by calling resume()/routeOut() directly — a `working` turn that stayed
// `working` in the view carries no route-out and is human-recoverable only by hand-editing run-state.yaml.
describe('§27 derived view — a relaunch-stranded turn surfaces a route-out (CWE-703/755)', () => {
  const appBundled = fileURLToPath(new URL('../../example/loops-v2', import.meta.url));
  const viewCtx = () => ({ tiers: { operator: null, appBundled }, repoDir: repo });

  it('derives a persisted `working` consolidator turn to a routable error over a fresh engine', () => {
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: CONSOLIDATE_KEY, status: 'working', round: 2 }, FIXED);
    const engine = makeEngine(); // fresh — no live turn, nothing has called resume()
    const view = provideAppLoopView(engine, 'plan-loop', viewCtx());
    expect(view.status).toBe('error'); // NOT the stranded `working`
    expect(view.humanNeeded).toBe(true); // the cue + OS notifier fire; the route-out renders
    expect(view.appTurn).toEqual({ step: STEP, turnKey: CONSOLIDATE_KEY });
    expect(view.iteration).toBe(2); // the round rides onto the route-out surface
  });

  it('derives a persisted `working` work turn to a routable error with no round', () => {
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'working' }, FIXED);
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
    audit.mockClear();
    engine.routeOut(repo, STEP, TURN_KEY, 'accept');
    expect(engine.liveErrorFor(repo)).not.toBeNull(); // route-out still reachable
    expect(audit).not.toHaveBeenCalledWith(repo, expect.stringContaining('accepted'), expect.anything());
  });

  it('a REVIEW-turn accept whose write fails holds the live error and records no accept', () => {
    writeReport(exampleRoundReport({ sections: ['summary'], roster: [ROSTER[0]] })); // present-but-malformed report
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: REVIEW_KEY, status: 'error', errorReason: 'malformed', round: 1 }, FIXED);
    const engine = makeEngine(failComplete);
    engine.resume(repo);
    audit.mockClear();
    engine.routeOut(repo, STEP, REVIEW_KEY, 'accept');
    expect(engine.liveErrorFor(repo)).not.toBeNull();
    expect(audit).not.toHaveBeenCalledWith(repo, expect.stringContaining('accept'), expect.anything());
  });

  it('a CONSOLIDATOR accept whose write fails holds the live error and records no accept (AC12)', () => {
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: CONSOLIDATE_KEY, status: 'error', errorReason: 'malformed verdict', round: 1 }, FIXED);
    const engine = makeEngine(failComplete);
    engine.resume(repo);
    audit.mockClear();
    engine.routeOut(repo, STEP, CONSOLIDATE_KEY, 'accept');
    expect(engine.liveErrorFor(repo)).not.toBeNull();
    expect(audit).not.toHaveBeenCalledWith(repo, expect.stringContaining('accept'), expect.anything());
  });
});
