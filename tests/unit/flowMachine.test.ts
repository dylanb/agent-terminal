import { afterEach, beforeEach, describe, it, expect } from 'vitest';
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

const LOAD: FlowLoad = { ok: true, definition: { name: 'f', steps: [{ id: 'step-1', kind: 'manual' }] } };

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
