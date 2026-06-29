import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlowMachine, createFlowManager, type FlowLoad } from '../../src/main/flow';
import { createFlowStateStore } from '../../src/main/flowState';

// Terminate (#26): a destructive flow-lifecycle transition valid only from in_progress/done that
// resets the flow to its never-started beginning and discards carried-over inputs (AC5/AC6). The
// observable contract is the resulting state view and the rejection on an illegal transition.

const LOAD: FlowLoad = {
  ok: true,
  definition: { name: 'f', steps: [{ id: 'step-1', kind: 'manual' }, { id: 'step-2', kind: 'manual' }] },
  flowDir: '/tmp/f/.agent-terminal',
};

describe('flow machine — terminate (#26 AC5/AC6)', () => {
  it('terminate from in_progress resets to not_started at the first step', () => {
    const flow = createFlowMachine(LOAD);
    flow.start();
    flow.advance(); // now in_progress at step-2
    const v = flow.terminate();
    expect(v.status).toBe('not_started');
    expect(v.position).toBe(1);
    expect(v.stepName).toBe('step-1');
    expect(flow.state().status).toBe('not_started');
  });

  it('terminate from done resets to not_started at the first step', () => {
    const flow = createFlowMachine(LOAD);
    flow.start();
    flow.advance();
    flow.advance(); // done (last step advanced)
    expect(flow.state().status).toBe('done');
    expect(flow.terminate().status).toBe('not_started');
  });

  it('discards carried-over inputs, so a fresh start surfaces none (AC6)', () => {
    let dir: string;
    dir = mkdtempSync(join(tmpdir(), 'flow-term-inputs-'));
    try {
      const store = createFlowStateStore(dir);
      const flow = createFlowMachine(LOAD, store);
      flow.start();
      flow.provideInput({ ticket: '176' });
      expect(store.read()?.inputs).toEqual({ ticket: '176' });
      flow.terminate();
      expect(store.read()?.inputs).toBeUndefined();
      expect(store.read()?.status).toBe('not_started');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects terminate from not_started and never mutates state', () => {
    const flow = createFlowMachine(LOAD);
    expect(() => flow.terminate()).toThrow();
    expect(flow.state().status).toBe('not_started');
  });

  it('is inert on an error load: terminate never throws and stays error', () => {
    const flow = createFlowMachine({ ok: false, error: 'no flow.yaml' });
    expect(flow.terminate().status).toBe('error');
  });

  it('an error load with a store writes nothing on terminate (a bad flow.yaml cannot wipe progression)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-term-err-'));
    try {
      const good = createFlowStateStore(dir);
      good.write({ step: 'step-1', status: 'in_progress' });
      const flow = createFlowMachine({ ok: false, error: 'no flow.yaml' }, good);
      flow.terminate();
      expect(good.read()?.status).toBe('in_progress'); // untouched
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('flow manager — terminate (#26 AC11 repo isolation)', () => {
  let a: string;
  let b: string;
  let home: string;
  const seed = (dir: string, name: string): void => {
    mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
    writeFileSync(join(dir, '.agent-terminal', 'flow.yaml'), `name: ${name}\nsteps:\n  - id: ${name}-step\n    kind: manual\n`);
  };
  beforeEach(() => {
    a = mkdtempSync(join(tmpdir(), 'flow-term-a-'));
    b = mkdtempSync(join(tmpdir(), 'flow-term-b-'));
    home = mkdtempSync(join(tmpdir(), 'flow-term-home-'));
    seed(a, 'alpha');
    seed(b, 'beta');
  });
  afterEach(() => {
    for (const d of [a, b, home]) rmSync(d, { recursive: true, force: true });
  });

  it('terminating one repo leaves another repo flow untouched (AC11)', () => {
    const mgr = createFlowManager({ globalDir: home });
    mgr.start(a);
    mgr.start(b);
    mgr.terminate(a);
    expect(mgr.state(a).status).toBe('not_started');
    expect(mgr.state(b).status).toBe('in_progress');
  });

  it('terminate persists across a fresh manager (relaunch) — still not_started (AC12)', () => {
    createFlowManager({ globalDir: home }).start(a);
    createFlowManager({ globalDir: home }).terminate(a);
    expect(createFlowManager({ globalDir: home }).state(a).status).toBe('not_started');
  });
});
