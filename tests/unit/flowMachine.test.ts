import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlowMachine, type FlowLoad } from '../../src/main/flow';
import { createFlowStateStore } from '../../src/main/flowState';

// §24.2.2 S1 — the walking-skeleton workflow state machine. A single manual step with the
// lifecycle not_started --start--> in_progress --advance--> done; done is terminal. Tests
// assert only the observable contract: the state view and thrown errors on illegal
// transitions (the machine's internals are free to change). S2 made the step's source a
// loaded definition; these tests feed a valid one and assert the lifecycle is unchanged.

const LOAD: FlowLoad = { ok: true, definition: { name: 'f', steps: [{ id: 'step-1', kind: 'manual' }] }, flowDir: '/tmp/f/.agent-terminal' };

describe('flow state machine (§24.2.2 S1)', () => {
  it('begins not_started at position 1/1 with a named step', () => {
    const flow = createFlowMachine(LOAD);
    const s = flow.state();
    expect(s.status).toBe('not_started');
    expect(s.position).toBe(1);
    expect(s.total).toBe(1);
    expect(s.stepName.length).toBeGreaterThan(0);
  });

  it('start() advances not_started → in_progress and persists', () => {
    const flow = createFlowMachine(LOAD);
    expect(flow.start().status).toBe('in_progress');
    expect(flow.state().status).toBe('in_progress');
  });

  it('advance() advances in_progress → done and persists', () => {
    const flow = createFlowMachine(LOAD);
    flow.start();
    expect(flow.advance().status).toBe('done');
    expect(flow.state().status).toBe('done');
  });

  it('rejects every illegal transition and never mutates state when it does', () => {
    const flow = createFlowMachine(LOAD);
    expect(() => flow.advance()).toThrow(); // not_started --advance--> illegal
    expect(flow.state().status).toBe('not_started');

    flow.start();
    expect(() => flow.start()).toThrow(); // in_progress --start--> illegal

    flow.advance();
    expect(() => flow.advance()).toThrow(); // done is terminal — a second Advance is impossible
    expect(() => flow.start()).toThrow();
    expect(flow.state().status).toBe('done');
  });
});

// §24.2.3 T1 — the multi-step walking skeleton. The machine tracks a current-step index and
// advances ACROSS steps: each Advance moves to the next step (staying in_progress) until the last,
// whose Advance reaches `done`. position/stepName walk the real steps; `done` is reachable only
// past the last step. Manual-only, no new backing (T1). The observable contract is the state view
// and thrown errors — never the internal index variable.
describe('flow state machine — multi-step (§24.2.3 T1)', () => {
  const THREE: FlowLoad = {
    ok: true,
    definition: {
      name: 'f',
      steps: [
        { id: 'groom', kind: 'manual' },
        { id: 'plan', kind: 'manual' },
        { id: 'implement', kind: 'manual' },
      ],
    },
    flowDir: '/tmp/f/.agent-terminal',
  };

  it('begins not_started at the first of N steps (1/3)', () => {
    const s = createFlowMachine(THREE).state();
    expect(s.status).toBe('not_started');
    expect(s.position).toBe(1);
    expect(s.total).toBe(3);
    expect(s.stepName).toBe('groom');
  });

  it('Advance walks across the steps, reaching done only past the last', () => {
    const flow = createFlowMachine(THREE);
    flow.start();
    expect([flow.state().position, flow.state().stepName, flow.state().status]).toEqual([1, 'groom', 'in_progress']);

    let v = flow.advance(); // step 1 → step 2 (still in progress)
    expect([v.position, v.stepName, v.status]).toEqual([2, 'plan', 'in_progress']);

    v = flow.advance(); // step 2 → step 3
    expect([v.position, v.stepName, v.status]).toEqual([3, 'implement', 'in_progress']);

    v = flow.advance(); // step 3 (last) → done
    expect(v.status).toBe('done');
    expect(v.position).toBe(3);
  });

  it('refuses to advance once done (done is terminal past the last step)', () => {
    const flow = createFlowMachine(THREE);
    flow.start();
    flow.advance();
    flow.advance();
    flow.advance(); // now done
    expect(() => flow.advance()).toThrow();
    expect(flow.state().status).toBe('done');
  });

  it('restart returns a completed multi-step flow to its first step, in progress', () => {
    const flow = createFlowMachine(THREE);
    flow.start();
    flow.advance();
    flow.advance();
    flow.advance();
    const v = flow.restart();
    expect([v.position, v.stepName, v.status]).toEqual([1, 'groom', 'in_progress']);
  });

  it('persists the current step so a fresh machine resumes mid-flow, on the right step', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-multi-'));
    try {
      const first = createFlowMachine(THREE, createFlowStateStore(dir));
      first.start();
      first.advance(); // now on step 2 (plan), in progress
      const resumed = createFlowMachine(THREE, createFlowStateStore(dir)).state();
      expect([resumed.position, resumed.stepName, resumed.status]).toEqual([2, 'plan', 'in_progress']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// §24.2.3 T2 — a loop step mirrors its agent-loop state.yaml. The machine folds the read-only
// mirror (via an injected readLoop) onto every view of a loop step, as a `loop` field parallel to
// derived; a manual step never mirrors. readLoop is read on each view so the mirror is live. The
// observable contract is the view's `loop` field — never how the machine reads the file.
describe('flow state machine — loop-step state.yaml mirror (§24.2.3 T2)', () => {
  const MIXED: FlowLoad = {
    ok: true,
    definition: {
      name: 'f',
      steps: [
        { id: 'groom', kind: 'manual' },
        { id: 'build', kind: 'loop', loop: 'impl-loop' },
      ],
    },
    flowDir: '/tmp/f/.agent-terminal',
  };
  const mirror = { status: 'awaiting-human-pr-approval', iteration: 9, pr: 179, branch: 'b' };

  it('folds the mirror onto a loop step view but NOT a manual step view', () => {
    const flow = createFlowMachine(MIXED, undefined, undefined, () => mirror);
    expect(flow.state().loop).toBeUndefined(); // step 1 is manual — no mirror
    flow.start();
    const v = flow.advance(); // → step 2 (loop)
    expect(v.loop).toMatchObject({ status: 'awaiting-human-pr-approval', iteration: 9, pr: 179 });
  });

  it('omits loop when the mirror is unavailable (missing/corrupt state.yaml → null)', () => {
    const flow = createFlowMachine(MIXED, undefined, undefined, () => null);
    flow.start();
    expect(flow.advance().loop).toBeUndefined();
  });

  it('reflects the live mirror — a later read sees the updated state.yaml', () => {
    let live = mirror;
    const flow = createFlowMachine(MIXED, undefined, undefined, () => live);
    flow.start();
    flow.advance();
    expect(flow.state().loop?.status).toBe('awaiting-human-pr-approval');
    live = { status: 'awaiting-team-review', iteration: 10, pr: 179, branch: 'b' };
    expect(flow.state().loop?.status).toBe('awaiting-team-review');
    expect(flow.state().loop?.iteration).toBe(10);
  });

  it('resolves the step\'s bound LoopDef so readiness + gate options are gate-driven', () => {
    const def = {
      name: 'impl-loop',
      gates: [
        { id: 'awaiting-human-pr-approval', kind: 'approve-required', humanOptions: ['approve', 'request-changes', 'impasse'], terminal: false },
        { id: 'awaiting-team-review', kind: 'terminal', humanOptions: [], terminal: true },
      ],
    };
    let live = mirror;
    const flow = createFlowMachine(MIXED, undefined, undefined, () => live, (name) => (name === 'impl-loop' ? def : null));
    flow.start();
    flow.advance(); // → step 2 (loop, bound to impl-loop)
    // At the awaiting gate: not ready, gate options surfaced from the gate's human_options.
    expect(flow.state().loop?.ready).toBe(false);
    expect(flow.state().loop?.gateOptions).toEqual(['approve', 'request-changes', 'impasse']);
    // At the terminal gate: ready, no options.
    live = { status: 'awaiting-team-review', iteration: 10, pr: 179, branch: 'b' };
    expect(flow.state().loop?.ready).toBe(true);
    expect(flow.state().loop?.gateOptions).toBeUndefined();
  });
});

// §24.2.2 S3 — the machine is backed by a real flow-state store: it restores its status from
// disk on construction (so a relaunch resumes where it left off) and persists every transition.
// Tests drive the real store over a temp dir; the observable contract is what a *fresh* machine
// on the same store reads back — never which write happened internally.
describe('flow machine persistence (§24.2.2 S3)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-machine-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists a transition so a fresh machine on the same store resumes it', () => {
    createFlowMachine(LOAD, createFlowStateStore(dir)).start();
    expect(createFlowMachine(LOAD, createFlowStateStore(dir)).state().status).toBe('in_progress');
  });

  it('resumes a completed flow as done across a relaunch', () => {
    const first = createFlowMachine(LOAD, createFlowStateStore(dir));
    first.start();
    first.advance();
    const resumed = createFlowMachine(LOAD, createFlowStateStore(dir));
    expect(resumed.state().status).toBe('done');
    expect(() => resumed.advance()).toThrow(); // still terminal after reload
  });

  it('ignores persisted state whose step id no longer matches the definition', () => {
    createFlowMachine(LOAD, createFlowStateStore(dir)).start();
    const otherDef: FlowLoad = {
      ok: true,
      definition: { name: 'f', steps: [{ id: 'different-step', kind: 'manual' }] },
      flowDir: '/tmp/f/.agent-terminal',
    };
    expect(createFlowMachine(otherDef, createFlowStateStore(dir)).state().status).toBe('not_started');
  });

  it('an error load with a store stays inert and writes nothing to disk', () => {
    const store = createFlowStateStore(dir);
    const flow = createFlowMachine({ ok: false, error: 'no flow.yaml' }, store);
    expect(flow.state().status).toBe('error');
    flow.start();
    flow.restart();
    expect(store.read()).toBeNull();
  });
});

// Restart from the completed state: reset and advance back to the first step (in_progress),
// so the workflow can be re-run. Only legal from done; persisted like any other transition.
describe('flow machine restart', () => {
  it('restart() moves done → in_progress (re-running the first step)', () => {
    const flow = createFlowMachine(LOAD);
    flow.start();
    flow.advance();
    expect(flow.restart().status).toBe('in_progress');
    expect(flow.state().status).toBe('in_progress');
  });

  it('is illegal before the flow is done and does not mutate state', () => {
    const flow = createFlowMachine(LOAD);
    expect(() => flow.restart()).toThrow(); // not_started
    expect(flow.state().status).toBe('not_started');
    flow.start();
    expect(() => flow.restart()).toThrow(); // in_progress
    expect(flow.state().status).toBe('in_progress');
  });

  it('persists the restart so a fresh machine resumes in_progress', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-restart-'));
    try {
      const first = createFlowMachine(LOAD, createFlowStateStore(dir));
      first.start();
      first.advance();
      first.restart();
      expect(createFlowMachine(LOAD, createFlowStateStore(dir)).state().status).toBe('in_progress');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Undo a manual advance: revert done → in_progress so a too-eager Advance can be taken back. It is
// the inverse of advance(), NOT a restart — it must NOT re-run the step's entry actions. Only legal
// from done; persisted like any other transition.
describe('flow machine undo (revert an advance)', () => {
  it('undo() moves done → in_progress', () => {
    const flow = createFlowMachine(LOAD);
    flow.start();
    flow.advance();
    expect(flow.undo().status).toBe('in_progress');
    expect(flow.state().status).toBe('in_progress');
  });

  it('is illegal anywhere but done and does not mutate state', () => {
    const flow = createFlowMachine(LOAD);
    expect(() => flow.undo()).toThrow(); // not_started
    expect(flow.state().status).toBe('not_started');
    flow.start();
    expect(() => flow.undo()).toThrow(); // in_progress
    expect(flow.state().status).toBe('in_progress');
  });

  it('does NOT re-run the step entry actions (unlike restart)', () => {
    const onEnter = vi.fn(() => ({}));
    const flow = createFlowMachine(LOAD, undefined, onEnter);
    flow.start();
    flow.advance();
    onEnter.mockClear();
    flow.undo();
    expect(onEnter).not.toHaveBeenCalled(); // undo reverts the state; it does not enter the step
  });

  it('persists the undo so a fresh machine resumes in_progress', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-undo-'));
    try {
      const first = createFlowMachine(LOAD, createFlowStateStore(dir));
      first.start();
      first.advance();
      first.undo();
      expect(createFlowMachine(LOAD, createFlowStateStore(dir)).state().status).toBe('in_progress');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is inert on an error load', () => {
    const flow = createFlowMachine({ ok: false, error: 'no flow.yaml' });
    expect(flow.undo().status).toBe('error'); // inert, never throws
  });
});

// §24.2.2 S4 — the machine runs the step's entry actions on ENTRY (start/restart) via an injected
// `onEnter(step)` callback, and merges any transient notice it returns onto the TRANSITION view
// only (a one-shot — `state()` never carries it). Entry actions are a property of entering a step,
// so advancing AWAY from a step does not fire them, and an inert error load never fires them.
describe('flow machine entry actions (§24.2.2 S4)', () => {
  it('fires onEnter with the step on start and merges its notice onto the returned view', () => {
    const onEnter = vi.fn(() => ({ notice: 'busy' }));
    const flow = createFlowMachine(LOAD, undefined, onEnter);
    const view = flow.start();
    expect(onEnter).toHaveBeenCalledWith(LOAD.definition.steps[0]);
    expect(view.notice).toBe('busy');
    expect(flow.state().notice).toBeUndefined(); // the notice is one-shot, not part of the state
  });

  it('fires onEnter on restart (the first step re-runs)', () => {
    const onEnter = vi.fn(() => ({}));
    const flow = createFlowMachine(LOAD, undefined, onEnter);
    flow.start();
    flow.advance();
    onEnter.mockClear();
    flow.restart();
    expect(onEnter).toHaveBeenCalledWith(LOAD.definition.steps[0]);
  });

  it('does not fire onEnter on advance (leaving the step is not entering it)', () => {
    const onEnter = vi.fn(() => ({}));
    const flow = createFlowMachine(LOAD, undefined, onEnter);
    flow.start();
    onEnter.mockClear();
    const view = flow.advance();
    expect(onEnter).not.toHaveBeenCalled();
    expect(view.notice).toBeUndefined();
  });

  it('never fires onEnter for an inert error load', () => {
    const onEnter = vi.fn(() => ({}));
    const flow = createFlowMachine({ ok: false, error: 'no flow.yaml' }, undefined, onEnter);
    flow.start();
    flow.restart();
    expect(onEnter).not.toHaveBeenCalled();
  });

  it('surfaces the step\'s bound todo_template ref in the view, for the on-demand picker (§6/§4.1)', () => {
    const templated: FlowLoad = {
      ok: true,
      definition: { name: 'f', steps: [{ id: 'groom', kind: 'manual', todoTemplate: 'ticket-grooming' }] },
      flowDir: '/tmp/f/.agent-terminal',
    };
    expect(createFlowMachine(templated).state().templateRef).toBe('ticket-grooming');
    expect(createFlowMachine(LOAD).state().templateRef).toBeUndefined(); // no binding → no ref
  });
});
