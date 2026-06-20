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
    const flow = createFlowMachine({ ok: false, kind: 'absent', error: 'no flow.yaml' }, store);
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
    const flow = createFlowMachine({ ok: false, kind: 'absent', error: 'no flow.yaml' });
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
    const flow = createFlowMachine({ ok: false, kind: 'absent', error: 'no flow.yaml' }, undefined, onEnter);
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
