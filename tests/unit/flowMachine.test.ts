import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlowMachine, type FlowLoad } from '../../src/main/flow';
import { createFlowStateStore, type FlowStateStore, type PersistedFlowState } from '../../src/main/flowState';
import { mkGate } from '../helpers/loopGate';

// §24.2.2 S1 — the walking-skeleton workflow state machine (lifecycle not_started → in_progress → done,
// done terminal). The observable contract is the state view and thrown errors on illegal transitions.

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
    expect(() => flow.advance()).toThrow();
    expect(flow.state().status).toBe('not_started');

    flow.start();
    expect(() => flow.start()).toThrow();

    flow.advance();
    expect(() => flow.advance()).toThrow();
    expect(() => flow.start()).toThrow();
    expect(flow.state().status).toBe('done');
  });
});

// §24.2.3 T1 — the multi-step walking skeleton: Advance walks across steps (staying in_progress) and
// reaches `done` only past the last step.
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

    let v = flow.advance();
    expect([v.position, v.stepName, v.status]).toEqual([2, 'plan', 'in_progress']);

    v = flow.advance();
    expect([v.position, v.stepName, v.status]).toEqual([3, 'implement', 'in_progress']);

    v = flow.advance();
    expect(v.status).toBe('done');
    expect(v.position).toBe(3);
  });

  it('refuses to advance once done (done is terminal past the last step)', () => {
    const flow = createFlowMachine(THREE);
    flow.start();
    flow.advance();
    flow.advance();
    flow.advance();
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
      first.advance();
      const resumed = createFlowMachine(THREE, createFlowStateStore(dir)).state();
      expect([resumed.position, resumed.stepName, resumed.status]).toEqual([2, 'plan', 'in_progress']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// §26.10 — starting a flow records WHEN it started, so the cost meter can price only the turns this run
// produced. The instant survives every transition within the run and is re-stamped by a fresh run.
describe('flow state machine — the run`s start instant (§26.10)', () => {
  const THREE: FlowLoad = {
    ok: true,
    definition: { name: 'f', steps: [{ id: 'groom', kind: 'manual' }, { id: 'plan', kind: 'manual' }] },
    flowDir: '/tmp/f/.agent-terminal',
  };
  let dir: string;
  const at = (ms: number) => () => ms;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-started-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stamps the start instant when the flow begins', () => {
    const store = createFlowStateStore(dir);
    createFlowMachine(THREE, store, undefined, undefined, undefined, undefined, at(1000)).start();
    expect(store.read()?.startedAt).toBe(1000);
  });

  it('a not_started flow has no start instant', () => {
    const store = createFlowStateStore(dir);
    createFlowMachine(THREE, store, undefined, undefined, undefined, undefined, at(1000)).state();
    expect(store.read()?.startedAt).toBeUndefined();
  });

  it('advancing through the flow preserves the original start instant', () => {
    const store = createFlowStateStore(dir);
    const flow = createFlowMachine(THREE, store, undefined, undefined, undefined, undefined, at(1000));
    flow.start();
    flow.advance();
    expect(store.read()?.startedAt).toBe(1000);
  });

  it('terminating clears the start instant, so the next run cannot inherit it', () => {
    const store = createFlowStateStore(dir);
    const flow = createFlowMachine(THREE, store, undefined, undefined, undefined, undefined, at(1000));
    flow.start();
    flow.terminate();
    expect(store.read()?.startedAt).toBeUndefined();
  });

  it('restarting a finished flow re-stamps the instant, so its cost starts from zero', () => {
    const store = createFlowStateStore(dir);
    let clock = 1000;
    const flow = createFlowMachine(THREE, store, undefined, undefined, undefined, undefined, () => clock);
    flow.start();
    flow.advance();
    flow.advance(); // → done
    clock = 5000;
    flow.restart();
    expect(store.read()?.startedAt).toBe(5000);
  });
});

// Slice B (§26.9) — a bootstrap that fails after its step was entered must not strand the flow on a
// half-entered loop step. revertStep(fromStepId) walks ONE step back, staying in_progress, WITHOUT
// re-running the previous step's entry actions (the inverse of an advance, like undo but mid-flow) and
// PRESERVING resolved inputs so the operator can fix the cause and re-advance. It is a no-op guard, not
// a throwing transition: it fires from an async pickup `.then()`, so a stale call (the flow already
// moved on) must be inert rather than an unhandled rejection.
describe('flow state machine — revertStep (§26.9 bootstrap-failure rollback)', () => {
  const THREE: FlowLoad = {
    ok: true,
    definition: {
      name: 'f',
      steps: [
        { id: 'groom', kind: 'manual' },
        { id: 'plan', kind: 'loop', loop: 'plan-loop', bootstrap: 'pickup' },
        { id: 'implement', kind: 'manual' },
      ],
    },
    flowDir: '/tmp/f/.agent-terminal',
  };

  it('walks one step back, staying in_progress, when the current step matches fromStepId', () => {
    const flow = createFlowMachine(THREE);
    flow.start();
    flow.advance(); // → plan (the bootstrap loop step)
    const v = flow.revertStep('plan');
    expect([v.position, v.stepName, v.status]).toEqual([1, 'groom', 'in_progress']);
    expect([flow.state().position, flow.state().stepName]).toEqual([1, 'groom']);
  });

  it('does NOT re-run the previous step\'s entry actions (unlike restart)', () => {
    let enters = 0;
    const flow = createFlowMachine(THREE, undefined, () => void enters++);
    flow.start(); // enter groom (1)
    flow.advance(); // enter plan (2)
    expect(enters).toBe(2);
    flow.revertStep('plan');
    expect(enters).toBe(2); // reverting groom is a rollback, not a re-entry — no skill re-injection
  });

  it('preserves resolved inputs so the operator can re-advance without re-typing them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-revert-'));
    try {
      const store = createFlowStateStore(dir);
      store.write({ step: 'plan', status: 'in_progress', inputs: { ticket: '176' } });
      const flow = createFlowMachine(THREE, store);
      flow.revertStep('plan');
      const persisted = createFlowStateStore(dir).read();
      expect(persisted?.step).toBe('groom');
      expect(persisted?.status).toBe('in_progress');
      expect(persisted?.inputs).toEqual({ ticket: '176' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when the current step no longer matches fromStepId (a stale async revert)', () => {
    const flow = createFlowMachine(THREE);
    flow.start();
    flow.advance(); // → plan
    const v = flow.revertStep('implement'); // stale: we are not on `implement`
    expect([v.position, v.stepName, v.status]).toEqual([2, 'plan', 'in_progress']);
  });

  it('is a no-op (never throws) from not_started or done', () => {
    const flow = createFlowMachine(THREE);
    expect(flow.revertStep('groom').status).toBe('not_started');
    flow.start();
    flow.advance();
    flow.advance();
    flow.advance(); // → done
    expect(flow.revertStep('implement').status).toBe('done');
  });

  it('reverts a first-step loop to not_started (no previous step), a recoverable state', () => {
    const FIRST_LOOP: FlowLoad = {
      ok: true,
      definition: {
        name: 'f',
        steps: [{ id: 'plan', kind: 'loop', loop: 'plan-loop', bootstrap: 'pickup' }],
      },
      flowDir: '/tmp/f/.agent-terminal',
    };
    const flow = createFlowMachine(FIRST_LOOP);
    flow.start(); // in_progress on the only (loop) step
    const v = flow.revertStep('plan');
    expect(v.status).toBe('not_started'); // Start re-enters the step and re-fires pickup
  });
});

// §24.2.3 T2 — a loop step folds its agent-loop state.yaml as the view's read-only `loop` field; a
// manual step never mirrors, and the mirror is re-read on each view so it stays live.
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
  const mirror = { status: 'awaiting-human-pr-approval', iteration: 9, pr: 179, branch: 'b', linkedIssues: [176] };

  it('folds the mirror onto a loop step view but NOT a manual step view', () => {
    const flow = createFlowMachine(MIXED, undefined, undefined, () => mirror);
    expect(flow.state().loop).toBeUndefined();
    flow.start();
    const v = flow.advance();
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
    live = { status: 'awaiting-team-review', iteration: 10, pr: 179, branch: 'b', linkedIssues: [176] };
    expect(flow.state().loop?.status).toBe('awaiting-team-review');
    expect(flow.state().loop?.iteration).toBe(10);
  });

  it('resolves the step\'s bound LoopDef so readiness + gate options are gate-driven', () => {
    const def = {
      name: 'impl-loop',
      phases: [],
      rosters: [],
      defaultRosterId: '',
      artifacts: {},
      workArtifact: '',
      gates: [
        mkGate({ id: 'awaiting-human-pr-approval', kind: 'approve-required', humanOptions: ['approve', 'request-changes', 'impasse'], terminal: false }),
        mkGate({ id: 'awaiting-team-review', kind: 'terminal', humanOptions: [], terminal: true }),
      ],
    };
    let live = mirror;
    const flow = createFlowMachine(MIXED, undefined, undefined, () => live, (name) => (name === 'impl-loop' ? def : null));
    flow.start();
    flow.advance();
    expect(flow.state().loop?.ready).toBe(false);
    expect(flow.state().loop?.gateOptions).toEqual(['approve', 'request-changes', 'impasse']);
    live = { status: 'awaiting-team-review', iteration: 10, pr: 179, branch: 'b', linkedIssues: [176] };
    expect(flow.state().loop?.ready).toBe(true);
    expect(flow.state().loop?.gateOptions).toBeUndefined();
  });
});

// The ticket + PR a flow is working surface as a `refs` field GATED BY FLOW PROGRESS (§24.2.3 T7): the
// github-ticket / pr inputs surface only once the step that requests them is entered; the loop's
// linked_issues ticket, its state.yaml pr, and the loop mirror surface only once a loop step is entered,
// staying until a terminate/restart resets the flow. Numbers only — descriptions are fetched lazily by
// the renderer.
describe('flow state machine — ticket/PR refs (progress-gated)', () => {
  const TICKET_FLOW: FlowLoad = {
    ok: true,
    definition: {
      name: 'f',
      steps: [
        { id: 'groom', kind: 'manual' },
        { id: 'plan', kind: 'loop', loop: 'plan-loop', bootstrap: 'pickup', inputs: [{ name: 'ticket', type: 'github-ticket', required: true }] },
      ],
    },
    flowDir: '/tmp/f/.agent-terminal',
  };
  const mirror = (over: Partial<{ pr: number | null; linkedIssues: number[] }> = {}) => ({
    status: 'planning',
    iteration: 1,
    pr: over.pr ?? null,
    branch: null,
    linkedIssues: over.linkedIssues ?? [],
  });

  // --- the github-ticket input is gated on entering the step that requests it ---
  it('does NOT surface a persisted github-ticket input value until its step is entered', () => {
    // The value is on disk (inputs are flow-wide), but the flow is still on the pre-input groom step.
    const store = createFlowStateStore(mkdtempSync(join(tmpdir(), 'flow-refs-')));
    store.write({ step: 'groom', status: 'in_progress', inputs: { ticket: '176' } });
    const flow = createFlowMachine(TICKET_FLOW, store, undefined, () => mirror());
    expect(flow.state().refs).toBeUndefined();
  });

  it('surfaces the github-ticket input value once its requesting step is entered', () => {
    const store = createFlowStateStore(mkdtempSync(join(tmpdir(), 'flow-refs-')));
    store.write({ step: 'plan', status: 'in_progress', inputs: { ticket: '176' } });
    const flow = createFlowMachine(TICKET_FLOW, store, undefined, () => mirror());
    expect(flow.state().refs?.ticket).toBe(176);
  });

  it('prefers the github-ticket input over linked_issues when BOTH are present', () => {
    // Pins precedence: a mutation swapping the `??` operands would otherwise pass the suite.
    const store = createFlowStateStore(mkdtempSync(join(tmpdir(), 'flow-refs-')));
    store.write({ step: 'plan', status: 'in_progress', inputs: { ticket: '176' } });
    const flow = createFlowMachine(TICKET_FLOW, store, undefined, () => mirror({ linkedIssues: [999] }));
    expect(flow.state().refs?.ticket).toBe(176);
  });

  // --- the loop's linked_issues ticket, state.yaml pr, and mirror are gated on entering a loop step ---
  it('does NOT surface the loop linked_issues, pr, or mirror on a pre-loop manual step', () => {
    const flow = createFlowMachine(TICKET_FLOW, undefined, undefined, () => mirror({ pr: 179, linkedIssues: [25] }));
    flow.start(); // step 0 is the manual `groom` step — the loop step has not been entered
    const v = flow.state();
    expect(v.refs).toBeUndefined();
    expect(v.loop).toBeUndefined();
  });

  it('surfaces the loop linked_issues ticket, pr, and mirror once the loop step is entered', () => {
    const flow = createFlowMachine(TICKET_FLOW, undefined, undefined, () => mirror({ pr: 179, linkedIssues: [25, 26] }));
    flow.start();
    flow.advance(); // enter the plan loop step
    const v = flow.state();
    expect(v.refs).toEqual({ ticket: 25, pr: 179 });
    expect(v.loop?.pr).toBe(179);
  });

  it('falls back to linked_issues when the github-ticket input is present but non-numeric', () => {
    const store = createFlowStateStore(mkdtempSync(join(tmpdir(), 'flow-refs-')));
    store.write({ step: 'plan', status: 'in_progress', inputs: { ticket: 'abc' } });
    const flow = createFlowMachine(TICKET_FLOW, store, undefined, () => mirror({ linkedIssues: [25] }));
    expect(flow.state().refs?.ticket).toBe(25);
  });

  it('omits refs entirely when neither a ticket nor a PR resolves, even on the loop step', () => {
    const flow = createFlowMachine(TICKET_FLOW, undefined, undefined, () => mirror());
    flow.start();
    flow.advance();
    expect(flow.state().refs).toBeUndefined();
  });

  // --- the pr branch's precedence/fallback twins of the github-ticket tests above ---
  // A loop step that also declares a pr-typed input, so entering it makes BOTH the pr input and the
  // loop's state.yaml pr eligible — the only shape that pins which source wins.
  const PR_LOOP_FLOW: FlowLoad = {
    ok: true,
    definition: {
      name: 'f',
      steps: [
        { id: 'groom', kind: 'manual' },
        { id: 'ship', kind: 'loop', loop: 'ship-loop', bootstrap: 'pickup', inputs: [{ name: 'thepr', type: 'pr', required: true }] },
      ],
    },
    flowDir: '/tmp/f/.agent-terminal',
  };

  it('prefers the pr-typed input over the loop state.yaml pr when BOTH are present', () => {
    // Pins precedence: a mutation swapping the `??` operands on the pr branch would otherwise pass.
    const store = createFlowStateStore(mkdtempSync(join(tmpdir(), 'flow-refs-')));
    store.write({ step: 'ship', status: 'in_progress', inputs: { thepr: '512' } });
    const flow = createFlowMachine(PR_LOOP_FLOW, store, undefined, () => mirror({ pr: 179 }));
    expect(flow.state().refs?.pr).toBe(512);
  });

  it('falls back to the loop state.yaml pr when the pr-typed input is present but non-numeric', () => {
    const store = createFlowStateStore(mkdtempSync(join(tmpdir(), 'flow-refs-')));
    store.write({ step: 'ship', status: 'in_progress', inputs: { thepr: 'abc' } });
    const flow = createFlowMachine(PR_LOOP_FLOW, store, undefined, () => mirror({ pr: 179 }));
    expect(flow.state().refs?.pr).toBe(179);
  });

  // --- a pr-typed input surfaces refs.pr with no loop at all, once its step is entered ---
  const PR_INPUT_FLOW: FlowLoad = {
    ok: true,
    definition: { name: 'f', steps: [{ id: 'review', kind: 'manual', inputs: [{ name: 'thepr', type: 'pr', required: true }] }] },
    flowDir: '/tmp/f/.agent-terminal',
  };

  it('surfaces a pr-typed input value as refs.pr once its step is entered (no loop needed)', () => {
    const store = createFlowStateStore(mkdtempSync(join(tmpdir(), 'flow-refs-')));
    store.write({ step: 'review', status: 'in_progress', inputs: { thepr: '512' } });
    const flow = createFlowMachine(PR_INPUT_FLOW, store, undefined, () => null);
    expect(flow.state().refs?.pr).toBe(512);
  });

  it('does NOT surface the pr input before its step is entered (not_started)', () => {
    const flow = createFlowMachine(PR_INPUT_FLOW, undefined, undefined, () => null);
    expect(flow.state().refs).toBeUndefined();
  });

  // The protective direction for the pr gate: a persisted pr-input value stays hidden while the flow is
  // on an EARLIER step, the symmetric twin of the github-ticket gate. Pins `prStepEntered`.
  const PR_INPUT_LATER_FLOW: FlowLoad = {
    ok: true,
    definition: {
      name: 'f',
      steps: [
        { id: 'a', kind: 'manual' },
        { id: 'review', kind: 'manual', inputs: [{ name: 'thepr', type: 'pr', required: true }] },
      ],
    },
    flowDir: '/tmp/f/.agent-terminal',
  };
  it('does NOT surface a persisted pr-input value until its requesting (later) step is entered', () => {
    const store = createFlowStateStore(mkdtempSync(join(tmpdir(), 'flow-refs-')));
    store.write({ step: 'a', status: 'in_progress', inputs: { thepr: '512' } });
    const flow = createFlowMachine(PR_INPUT_LATER_FLOW, store, undefined, () => null);
    expect(flow.state().refs).toBeUndefined(); // on step 'a', before the pr step
    flow.advance(); // enter 'review' (the pr step)
    expect(flow.state().refs?.pr).toBe(512);
  });

  // --- sticky within a run: once a loop step is entered, its refs + mirror persist onto a later step ---
  const STICKY_FLOW: FlowLoad = {
    ok: true,
    definition: {
      name: 'f',
      steps: [
        { id: 'groom', kind: 'manual' },
        { id: 'build', kind: 'loop', loop: 'impl-loop' },
        { id: 'wrap', kind: 'manual' },
      ],
    },
    flowDir: '/tmp/f/.agent-terminal',
  };

  it('keeps the loop refs and mirror visible on a post-loop manual step (sticky for the run)', () => {
    const flow = createFlowMachine(STICKY_FLOW, undefined, undefined, () => mirror({ pr: 179, linkedIssues: [25] }));
    flow.start();
    flow.advance(); // enter build (the loop step)
    flow.advance(); // advance to wrap (a manual step AFTER the loop)
    const v = flow.state();
    expect(v.refs).toEqual({ ticket: 25, pr: 179 });
    expect(v.loop?.pr).toBe(179);
  });

  // The not_started gate (entered=[]) must hold even when the FIRST step is a loop/input step — an index
  // reset alone would otherwise reopen the gate at step 0. Pins the `status === 'not_started'` branch.
  const LOOP_FIRST_FLOW: FlowLoad = {
    ok: true,
    definition: {
      name: 'f',
      steps: [{ id: 'build', kind: 'loop', loop: 'impl-loop', inputs: [{ name: 'ticket', type: 'github-ticket', required: true }] }],
    },
    flowDir: '/tmp/f/.agent-terminal',
  };

  it('keeps the display closed at not_started even when the first step is the loop step', () => {
    const flow = createFlowMachine(LOOP_FIRST_FLOW, undefined, undefined, () => mirror({ pr: 179, linkedIssues: [25] }));
    const v = flow.state(); // not_started — nothing entered, so the gate is closed
    expect(v.refs).toBeUndefined();
    expect(v.loop).toBeUndefined();
  });

  it('recloses the display after terminate even when the first step is the loop step', () => {
    const flow = createFlowMachine(LOOP_FIRST_FLOW, undefined, undefined, () => mirror({ pr: 179, linkedIssues: [25] }));
    flow.start(); // enter the loop step → visible
    expect(flow.state().refs).toEqual({ ticket: 25, pr: 179 });
    flow.terminate(); // → not_started, index 0
    expect(flow.state().refs).toBeUndefined();
    expect(flow.state().loop).toBeUndefined();
  });

  // Two loop steps bound to DISTINCT LoopDefs: the mirror binds to the most-recently-entered loop step's
  // def, including on a later manual step (a first-wins reduce would surface the wrong gate options).
  const TWO_LOOP_FLOW: FlowLoad = {
    ok: true,
    definition: {
      name: 'f',
      steps: [
        { id: 'first', kind: 'loop', loop: 'loop-a' },
        { id: 'second', kind: 'loop', loop: 'loop-b' },
        { id: 'wrap', kind: 'manual' },
      ],
    },
    flowDir: '/tmp/f/.agent-terminal',
  };
  const defA = { name: 'loop-a', phases: [], rosters: [], defaultRosterId: '', artifacts: {}, workArtifact: '', gates: [mkGate({ id: 'planning', kind: 'approve-required', humanOptions: ['approve'], terminal: false })] };
  const defB = { name: 'loop-b', phases: [], rosters: [], defaultRosterId: '', artifacts: {}, workArtifact: '', gates: [mkGate({ id: 'planning', kind: 'approve-required', humanOptions: ['approve', 'impasse'], terminal: false })] };

  it('binds the mirror to the most recently entered loop step LoopDef, across two loops and onto a later manual step', () => {
    const flow = createFlowMachine(TWO_LOOP_FLOW, undefined, undefined, () => mirror(), (name) => (name === 'loop-a' ? defA : name === 'loop-b' ? defB : null));
    flow.start(); // first (loop-a)
    expect(flow.state().loop?.gateOptions).toEqual(['approve']);
    flow.advance(); // second (loop-b)
    expect(flow.state().loop?.gateOptions).toEqual(['approve', 'impasse']);
    flow.advance(); // wrap (manual, post-loop) → still loop-b, the most-recently-entered loop
    expect(flow.state().loop?.gateOptions).toEqual(['approve', 'impasse']);
  });

  // Two github-ticket inputs in different steps: the ref VALUE comes from the FIRST such input and the
  // GATE opens once that first step is entered, so value-source and gate stay consistent (the first is
  // entered no later than any later one).
  const TWO_TICKET_FLOW: FlowLoad = {
    ok: true,
    definition: {
      name: 'f',
      steps: [
        { id: 'a', kind: 'manual', inputs: [{ name: 'ta', type: 'github-ticket', required: true }] },
        { id: 'b', kind: 'manual', inputs: [{ name: 'tb', type: 'github-ticket', required: true }] },
      ],
    },
    flowDir: '/tmp/f/.agent-terminal',
  };
  it('resolves the ticket from the first github-ticket input, gated on entering that first step', () => {
    const store = createFlowStateStore(mkdtempSync(join(tmpdir(), 'flow-refs-')));
    store.write({ step: 'a', status: 'in_progress', inputs: { ta: '11', tb: '22' } });
    const flow = createFlowMachine(TWO_TICKET_FLOW, store, undefined, () => null);
    expect(flow.state().refs?.ticket).toBe(11);
  });

  // Terminate/Restart reset the flow to its first step, closing every progress gate: the prior run's
  // ticket/PR display clears with NO state.yaml write and stays clear until the flow re-enters a loop
  // step (§24.2.3 T7).
  describe('terminate/restart close the progress gates', () => {
    it('terminate() clears the loop-derived refs and mirror', () => {
      const flow = createFlowMachine(TICKET_FLOW, undefined, undefined, () => mirror({ pr: 179, linkedIssues: [25] }));
      flow.start();
      flow.advance(); // on the loop step → refs visible
      expect(flow.state().refs).toEqual({ ticket: 25, pr: 179 });
      flow.terminate();
      const after = flow.state();
      expect(after.refs).toBeUndefined();
      expect(after.loop).toBeUndefined();
    });

    it('restart() clears the display until the loop step is re-entered — state.yaml unchanged throughout', () => {
      const flow = createFlowMachine(TICKET_FLOW, undefined, undefined, () => mirror({ pr: 179, linkedIssues: [25] }));
      flow.start();
      flow.advance();
      flow.advance(); // → done (past the last step)
      expect(flow.state().refs).toEqual({ ticket: 25, pr: 179 });
      flow.restart(); // → in_progress at the groom step; the loop step is no longer entered
      expect(flow.state().refs).toBeUndefined();
      expect(flow.state().loop).toBeUndefined();
      flow.advance(); // re-enter the loop step → the live loop is shown again
      expect(flow.state().refs).toEqual({ ticket: 25, pr: 179 });
    });

    it('does NOT re-reveal the loop while the same loop merely advances after a terminate', () => {
      // The SAME agent loop keeps running and rewrites its state.yaml (iteration/status bump). With the
      // flow at not_started and no loop step entered, the display must stay clear.
      let live = mirror({ pr: 179, linkedIssues: [25] });
      const flow = createFlowMachine(TICKET_FLOW, undefined, undefined, () => live);
      flow.start();
      flow.advance();
      expect(flow.state().refs).toEqual({ ticket: 25, pr: 179 });
      flow.terminate();
      expect(flow.state().refs).toBeUndefined();
      live = { status: 'building', iteration: 10, pr: 179, branch: null, linkedIssues: [25] }; // same loop, advanced
      expect(flow.state().refs).toBeUndefined();
    });

    it('surfaces a typed-input ticket provided after restart once its requesting step is re-entered', () => {
      const flow = createFlowMachine(TICKET_FLOW, undefined, undefined, () => mirror({ pr: 179, linkedIssues: [25] }));
      flow.start();
      flow.advance();
      flow.advance(); // → done
      flow.restart(); // returns to the groom step and clears inputs
      expect(flow.state().refs).toBeUndefined();
      flow.advance(); // re-enter the plan step (which requests the ticket)
      flow.provideInput({ ticket: '99' }); // a fresh, flow-owned ticket
      expect(flow.state().refs).toEqual({ ticket: 99, pr: 179 });
    });
  });
});

// §24.2.2 S3 — the machine restores its status from a real flow-state store on construction and
// persists every transition; the observable contract is what a fresh machine on the same store reads back.
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
    expect(() => resumed.advance()).toThrow();
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

// Restart is legal only from done: it re-runs the workflow from the first step (in_progress).
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
    expect(() => flow.restart()).toThrow();
    expect(flow.state().status).toBe('not_started');
    flow.start();
    expect(() => flow.restart()).toThrow();
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

// Undo reverts done → in_progress (legal only from done). It is the inverse of advance(), NOT a restart:
// it must NOT re-run the step's entry actions.
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
    expect(() => flow.undo()).toThrow();
    expect(flow.state().status).toBe('not_started');
    flow.start();
    expect(() => flow.undo()).toThrow();
    expect(flow.state().status).toBe('in_progress');
  });

  it('does NOT re-run the step entry actions (unlike restart)', () => {
    const onEnter = vi.fn(() => ({}));
    const flow = createFlowMachine(LOAD, undefined, onEnter);
    flow.start();
    flow.advance();
    onEnter.mockClear();
    flow.undo();
    expect(onEnter).not.toHaveBeenCalled();
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
    expect(flow.undo().status).toBe('error'); // inert error load: never throws
  });
});

// §24.2.2 S4 — entry actions fire on step ENTRY (start/restart); a returned notice merges onto the
// TRANSITION view only (one-shot — `state()` never carries it).
describe('flow machine entry actions (§24.2.2 S4)', () => {
  it('fires onEnter with the step on start and merges its notice onto the returned view', () => {
    const onEnter = vi.fn(() => ({ notice: 'busy' }));
    const flow = createFlowMachine(LOAD, undefined, onEnter);
    const view = flow.start();
    expect(onEnter).toHaveBeenCalledWith(LOAD.definition.steps[0], {});
    expect(view.notice).toBe('busy');
    expect(flow.state().notice).toBeUndefined();
  });

  it('fires onEnter on restart (the first step re-runs)', () => {
    const onEnter = vi.fn(() => ({}));
    const flow = createFlowMachine(LOAD, undefined, onEnter);
    flow.start();
    flow.advance();
    onEnter.mockClear();
    flow.restart();
    expect(onEnter).toHaveBeenCalledWith(LOAD.definition.steps[0], {});
  });

  it('does not fire onEnter when advancing completes the flow (done enters no step)', () => {
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
    expect(createFlowMachine(LOAD).state().templateRef).toBeUndefined();
  });
});

// §24.2.3 T3 — entry actions fire on EVERY entry, including advancing from step i INTO step i+1, not
// only start/restart of the first step. Advancing past the LAST step reaches `done`, which enters no step.
describe('flow machine entry-on-advance (§24.2.3 T3)', () => {
  const TWO: FlowLoad = {
    ok: true,
    definition: { name: 'f', steps: [{ id: 'groom', kind: 'manual' }, { id: 'plan', kind: 'manual' }] },
    flowDir: '/tmp/f/.agent-terminal',
  };

  it('fires onEnter for the step being advanced INTO, merging its notice', () => {
    const onEnter = vi.fn(() => ({ notice: 'busy' }));
    const flow = createFlowMachine(TWO, undefined, onEnter);
    flow.start();
    onEnter.mockClear();
    const view = flow.advance();
    expect(onEnter).toHaveBeenCalledWith(TWO.definition.steps[1], {});
    expect(view.notice).toBe('busy');
    expect(flow.state().notice).toBeUndefined();
  });

  it('does not fire onEnter when the last Advance completes the flow', () => {
    const onEnter = vi.fn(() => ({}));
    const flow = createFlowMachine(TWO, undefined, onEnter);
    flow.start();
    flow.advance();
    onEnter.mockClear();
    const view = flow.advance();
    expect(view.status).toBe('done');
    expect(onEnter).not.toHaveBeenCalled();
  });
});

// §24.2.3 T3 — typed-input bootstrap (§18.4). A returned `prompt` merges onto the transition view
// (one-shot, like `notice`); `provideInput(values)` persists the answer and re-enters the step. The
// machine routes inputs to the entry action and injects nothing itself.
describe('flow machine typed-input bootstrap (§24.2.3 T3)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-machine-t3-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const PROMPT = { inputs: [{ name: 'ticket', type: 'github-ticket' }], bootstrap: 'agent-loop pickup' };
  const bootEnter = vi.fn((_step, inputs: Record<string, string> = {}) =>
    inputs.ticket ? { notice: `booted:${inputs.ticket}` } : { prompt: PROMPT },
  );

  it('merges the entry prompt onto the start view when the input is unsatisfied', () => {
    bootEnter.mockClear();
    const flow = createFlowMachine(LOAD, undefined, bootEnter);
    const view = flow.start();
    expect(bootEnter).toHaveBeenCalledWith(LOAD.definition.steps[0], {});
    expect(view.prompt).toEqual(PROMPT);
    expect(view.notice).toBeUndefined();
    expect(flow.state().prompt).toBeUndefined();
  });

  it('provideInput threads the value into re-entry, persists it, and clears the prompt', () => {
    const store = createFlowStateStore(dir);
    const flow = createFlowMachine(LOAD, store, bootEnter);
    flow.start();
    bootEnter.mockClear();
    const view = flow.provideInput({ ticket: '176' });
    expect(bootEnter).toHaveBeenCalledWith(LOAD.definition.steps[0], { ticket: '176' });
    expect(view.notice).toBe('booted:176');
    expect(view.prompt).toBeUndefined();
    expect(store.read()?.inputs).toEqual({ ticket: '176' });
  });

  it('clears persisted inputs on restart so a re-entered required input re-prompts', () => {
    createFlowStateStore(dir).write({ step: 'step-1', status: 'done', inputs: { ticket: '176' } });
    bootEnter.mockClear();
    const resumed = createFlowMachine(LOAD, createFlowStateStore(dir), bootEnter);
    const view = resumed.restart();
    // Restart wipes resolved inputs: the first step re-enters with none, so its required input prompts again.
    expect(bootEnter).toHaveBeenCalledWith(LOAD.definition.steps[0], {});
    expect(view.prompt).toEqual(PROMPT);
    expect(view.notice).toBeUndefined();
    // The cleared inputs are persisted, so a later resume cannot resurrect the stale value.
    expect(createFlowStateStore(dir).read()?.inputs).toBeUndefined();
  });

  it('threads a value resolved at one step into a LATER step\'s same-named input (§18.1 output→input)', () => {
    const TWO_BOOT: FlowLoad = {
      ok: true,
      definition: {
        name: 'f',
        steps: [
          { id: 'plan', kind: 'loop', loop: 'plan-loop', bootstrap: 'pickup', inputs: [{ name: 'ticket', type: 'github-ticket', required: true }] },
          { id: 'impl', kind: 'loop', loop: 'impl-loop', bootstrap: 'pickup', inputs: [{ name: 'ticket', type: 'github-ticket', required: true }] },
        ],
      },
      flowDir: '/tmp/f/.agent-terminal',
    };
    const flow = createFlowMachine(TWO_BOOT, createFlowStateStore(dir), bootEnter);
    expect(flow.start().prompt).toEqual(PROMPT);
    flow.provideInput({ ticket: '176' });
    bootEnter.mockClear();
    const view = flow.advance();
    expect(bootEnter).toHaveBeenCalledWith(TWO_BOOT.definition.steps[1], { ticket: '176' });
    expect(view.prompt).toBeUndefined();
    expect(view.notice).toBe('booted:176');
  });

  it('provideInput is illegal unless a step is being worked (in_progress)', () => {
    const flow = createFlowMachine(LOAD, undefined, bootEnter);
    expect(() => flow.provideInput({ ticket: '176' })).toThrow();
  });
});

// The flow-state.yaml on disk is the source of truth (§19.1): another process (the agent-loop CLI
// advancing the flow, or a manual edit) can move the progression while the app runs. state() must
// reflect the current disk contents, not a snapshot frozen at construction.
describe('flow state machine — state() reflects external disk changes (§19.1)', () => {
  const THREE_STEP: FlowLoad = {
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

  it('re-reads the persisted step/status from the store on every state() query', () => {
    let stored: PersistedFlowState | null = { step: 'groom', status: 'in_progress' };
    const store: FlowStateStore = { read: () => stored, write: (s) => void (stored = s) };
    const flow = createFlowMachine(THREE_STEP, store);
    expect(flow.state().stepName).toBe('groom');
    stored = { step: 'implement', status: 'in_progress' }; // external advance on disk
    expect(flow.state().stepName).toBe('implement');
    expect(flow.state().status).toBe('in_progress');
  });

  it('reflects a flow-state.yaml deleted out from under it as not_started', () => {
    let stored: PersistedFlowState | null = { step: 'implement', status: 'in_progress' };
    const store: FlowStateStore = { read: () => stored, write: (s) => void (stored = s) };
    const flow = createFlowMachine(THREE_STEP, store);
    expect(flow.state().status).toBe('in_progress');
    stored = null; // file removed/cleared on disk
    const s = flow.state();
    expect(s.status).toBe('not_started');
    expect(s.stepName).toBe('groom'); // back to the first step
  });
});
