import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppLoopEngine, type AppLoopEngineDeps } from '../../src/main/appLoopEngine';
import { readAppLoopState, writeAppLoopState, type AppLoopRunState } from '../../src/main/appLoopState';
import { completionMarker } from '../../src/main/appWorkTurn';
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

/** A file-producing plan-loop def whose completion artifact resolves under the repo's §27 area. */
function fileDef(): LoopDefV2 {
  return {
    version: 'v2',
    name: 'plan-loop',
    origin: 'app-bundled',
    work: { recipe: join(repo, 'recipe', 'work.md'), artifact: 'plan' },
    reviewers: [],
    consolidator: join(repo, 'recipe', 'consolidate.md'),
    boundaries: [{ boundary: 'pre-work', mode: 'clear' }],
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
    now: FIXED,
    resolveDef: () => defResult,
    readRecipe: () => '# work turn\nProduce the plan.',
    readArtifact: (p) => readArtifact(p),
    persist: persistOverride ?? ((repoDir, state) => writeAppLoopState(repoDir, state, FIXED)),
    audit,
    emitError,
    onViewChanged: () => {},
    terminateFlow,
  };
  return createAppLoopEngine(deps);
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

describe('§27 engine — completion gate (AC2, AC3)', () => {
  it('completes on the done-signal + a marker-bearing artifact, and never re-injects (runs once)', () => {
    const engine = makeEngine();
    enterAndInjectWork(engine);
    writeArtifact(true);
    engine.onDoneSignal();
    expect(readAppLoopState(repo)?.status).toBe('complete');
    const after = injected.length;
    engine.onInjectable(); // nothing pending — must not re-inject a completed turn
    engine.onDoneSignal();
    expect(injected.length).toBe(after);
  });

  it('a def declaring no artifact completes on the done-signal alone, reading no artifact (AC3)', () => {
    defResult = { ok: true, def: commitDef() };
    const engine = makeEngine();
    enterAndInjectWork(engine);
    engine.onDoneSignal();
    expect(readAppLoopState(repo)?.status).toBe('complete');
    expect(readArtifact).not.toHaveBeenCalled(); // commit-producing: no artifact read

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
    engine.routeOut(repo, STEP, TURN_KEY, 'accept'); // artifact absent
    expect(readAppLoopState(repo)?.status).toBe('error');
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

  it('never re-runs a completed turn on resume', () => {
    writeAppLoopState(repo, { loop: 'plan-loop', step: STEP, turnKey: TURN_KEY, status: 'complete' }, FIXED);
    const engine = makeEngine();
    engine.resume(repo);
    expect(injected).toEqual([]);
    expect(readAppLoopState(repo)?.status).toBe('complete');
  });
});
