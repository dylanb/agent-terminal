import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFlowMachine, MAX_SLICES, type FlowLoad } from '../../src/main/flow';
import { createFlowStateStore, type FlowStateStore, type PersistedFlowState } from '../../src/main/flowState';
import type { FlowLoopView } from '../../src/shared/ipc';
import { MAX_ECHOED_LOAD_ERROR_LENGTH } from '../../src/shared/controlChars';

// §24.2.2 S1 — the walking-skeleton workflow state machine (lifecycle not_started → in_progress → done,
// done terminal). The observable contract is the state view and thrown errors on illegal transitions.

const LOAD: FlowLoad = { ok: true, definition: { name: 'f', steps: [{ id: 'step-1', kind: 'manual' }] }, flowDir: '/tmp/f/.agent-terminal' };

/** An in-memory store over a caller-owned progression slot. `write` replaces the whole document, as the
 *  real store's does, so a name absent from the written state is a name cleared — not one retained. */
const memStore = (read: () => PersistedFlowState | null, set: (s: PersistedFlowState) => void): Omit<FlowStateStore, 'clearProgression'> => {
  let named: string | null = null;
  return {
    read,
    write: (s) => {
      named = s.title ?? null;
      set(s);
    },
    readTitle: () => named,
    writeTitle: (t) => void (named = t),
  };
};

describe('the user title the status bar shows (§22.3.1)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-title-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces the persisted title on the view', () => {
    const store = createFlowStateStore(dir);
    store.write({ step: 'step-1', status: 'in_progress', title: 'Refactor the shadow parser' });
    expect(createFlowMachine(LOAD, store).state().userTitle).toBe('Refactor the shadow parser');
  });

  it('reports no title for a flow the user never named', () => {
    expect(createFlowMachine(LOAD, createFlowStateStore(dir)).state().userTitle).toBeUndefined();
  });

  it('keeps the title across every transition, so clicking Start never destroys the name', () => {
    const store = createFlowStateStore(dir);
    store.write({ step: 'step-1', status: 'not_started', title: 'Refactor the shadow parser' });
    const flow = createFlowMachine(LOAD, store);
    expect(flow.start().userTitle).toBe('Refactor the shadow parser');
    expect(flow.advance().userTitle).toBe('Refactor the shadow parser');
    expect(store.read()?.title).toBe('Refactor the shadow parser');
  });

  it('persists a name the user typed', () => {
    const store = createFlowStateStore(dir);
    const flow = createFlowMachine(LOAD, store);
    expect(flow.setTitle('Refactor the shadow parser').userTitle).toBe('Refactor the shadow parser');
    expect(store.readTitle()).toBe('Refactor the shadow parser');
    expect(createFlowMachine(LOAD, store).state().userTitle).toBe('Refactor the shadow parser'); // survives relaunch
  });

  it('names a directory whose flow never loaded — the case where nothing else can name it', () => {
    // Every directory without a flow.yaml is a load-error view, and it has no PR and no ticket either,
    // so the user title is the only name it can ever have (§22.3.1).
    const store = createFlowStateStore(dir);
    const flow = createFlowMachine({ ok: false, error: 'no flow.yaml' }, store);
    expect(flow.setTitle('Spike the parser').userTitle).toBe('Spike the parser');
    expect(store.readTitle()).toBe('Spike the parser');
    expect(createFlowMachine({ ok: false, error: 'no flow.yaml' }, store).state().userTitle).toBe('Spike the parser');
  });

  it('names a broken flow without clobbering the progression a good flow.yaml left behind', () => {
    const store = createFlowStateStore(dir);
    store.write({ step: 'step-1', status: 'in_progress' });
    createFlowMachine({ ok: false, error: 'bad yaml' }, store).setTitle('Spike the parser');
    expect(store.read()).toEqual({ step: 'step-1', status: 'in_progress', title: 'Spike the parser' });
  });

  it('keeps every other transition inert on a flow that failed to load', () => {
    const store = createFlowStateStore(dir);
    store.write({ step: 'step-1', status: 'in_progress' });
    const flow = createFlowMachine({ ok: false, error: 'bad yaml' }, store);
    flow.start();
    flow.advance();
    flow.terminate();
    expect(store.read()).toEqual({ step: 'step-1', status: 'in_progress' });
  });

  it('merges the name onto the progression on disk, not onto a stale snapshot of it', () => {
    // The machine is long-lived and the editor can sit open indefinitely; an advance that landed
    // out-of-band must not be rewound by the act of naming the work.
    const steps: FlowLoad = {
      ok: true,
      definition: { name: 'f', steps: [{ id: 'step-1', kind: 'manual' }, { id: 'step-3', kind: 'manual' }] },
      flowDir: '/tmp/f/.agent-terminal',
    };
    const store = createFlowStateStore(dir);
    const flow = createFlowMachine(steps, store);
    flow.start();
    createFlowStateStore(dir).write({ step: 'step-3', status: 'in_progress' }); // an external advance
    flow.setTitle('Refactor the shadow parser');
    expect(store.read()).toEqual({ step: 'step-3', status: 'in_progress', title: 'Refactor the shadow parser' });
  });

  it('refuses a title update when the progression has unknown fields and preserves its bytes', () => {
    const file = join(dir, '.agent-terminal', 'flow-state.yaml');
    const store = createFlowStateStore(dir);
    store.write({ step: 'step-1', status: 'in_progress' });
    const before = 'step: step-1\nstatus: in_progress\nfuture_extension: keep-me\n';
    writeFileSync(file, before);

    expect(() => createFlowMachine(LOAD, store).setTitle('Named')).toThrow(/unrecognized/i);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('does not go on holding a name whose write was refused', () => {
    // A machine that keeps a name it failed to persist commits it silently on the next transition, long
    // after the UI told the user the write failed.
    const store = createFlowStateStore(dir);
    let fail = true;
    const flaky: FlowStateStore = {
      ...store,
      write: (s: PersistedFlowState) => {
        if (fail) throw new Error('EROFS');
        store.write(s);
      },
      writeTitle: (t: string | null) => {
        if (fail) throw new Error('EROFS');
        store.writeTitle(t);
      },
    };
    const flow = createFlowMachine(LOAD, flaky);
    expect(() => flow.setTitle('never lands')).toThrow('EROFS');
    fail = false;
    // No state() in between: a hydrate would mask the stale name. The very next transition is what
    // would smuggle it onto disk, long after the UI told the user the write failed.
    flow.start();
    expect(store.read()?.title).toBeUndefined();
  });

  it('clears the name when the user empties it, rather than persisting a blank', () => {
    const store = createFlowStateStore(dir);
    const flow = createFlowMachine(LOAD, store);
    flow.setTitle('Refactor the shadow parser');
    expect(flow.setTitle('   ').userTitle).toBeUndefined();
    expect(store.read()?.title).toBeUndefined();
  });

  it('keeps the title when the flow is terminated — the name outlives the run it named', () => {
    const store = createFlowStateStore(dir);
    store.write({ step: 'step-1', status: 'in_progress', title: 'Refactor the shadow parser' });
    const flow = createFlowMachine(LOAD, store);
    const after = flow.terminate();
    expect(after.status).toBe('not_started');
    expect(after.userTitle).toBe('Refactor the shadow parser');
  });
});

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

// §18.3 / §27 — a bootstrap that fails after its step was entered must not strand the flow on a
// half-entered loop step. revertStep(fromStepId) walks ONE step back, staying in_progress, WITHOUT
// re-running the previous step's entry actions (the inverse of an advance, like undo but mid-flow) and
// PRESERVING resolved inputs so the operator can fix the cause and re-advance; from the first step there is no
// previous step, so it resets the run to never-started as a Terminate does (§18.7.4, v2.161). It is a no-op guard, not
// a throwing transition: it fires from an async pickup `.then()`, so a stale call (the flow already
// moved on) must be inert rather than an unhandled rejection.
describe('flow state machine — revertStep (§18.3 bootstrap-failure rollback)', () => {
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

  it('resets a first-step rollback to never-started as a Terminate does, discarding resolved inputs (§18.7.4, v2.161)', () => {
    const FIRST_LOOP: FlowLoad = {
      ok: true,
      definition: {
        name: 'f',
        steps: [{ id: 'plan', kind: 'loop', loop: 'plan-loop', bootstrap: 'pickup' }],
      },
      flowDir: '/tmp/f/.agent-terminal',
    };
    const dir = mkdtempSync(join(tmpdir(), 'flow-revert-first-'));
    try {
      const store = createFlowStateStore(dir);
      store.write({ step: 'plan', status: 'in_progress', inputs: { ticket: '176' } });
      const flow = createFlowMachine(FIRST_LOOP, store);
      const v = flow.revertStep('plan');
      expect(v.status).toBe('not_started');
      const persisted = createFlowStateStore(dir).read();
      expect(persisted?.status).toBe('not_started');
      expect(persisted?.inputs ?? {}).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// §27.15 — a loop step folds the §27 loop-view provider's result as the view's read-only `loop` field;
// a manual step never consults the provider, and the provider is re-read on each view so the loop view
// stays live. (Engine selection by binding is flowLoopNamespace.test.ts; def→view is loopViewV2.)
describe('flow state machine — loop-step §27 loop view (§27.15)', () => {
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
  const gateView: FlowLoopView = { status: 'awaiting-human-pr-approval', iteration: 9, pr: 179, branch: 'b', ready: false, actionable: true, humanNeeded: true };

  it('folds the provider view onto a loop step view but NOT a manual step view', () => {
    const flow = createFlowMachine(MIXED, undefined, undefined, () => gateView);
    expect(flow.state().loop).toBeUndefined(); // still on the manual groom step
    flow.start();
    const v = flow.advance(); // enter the loop step
    expect(v.loop).toEqual(gateView);
  });

  it('reflects the live provider — a later read sees the updated loop view', () => {
    let live: FlowLoopView = gateView;
    const flow = createFlowMachine(MIXED, undefined, undefined, () => live);
    flow.start();
    flow.advance();
    expect(flow.state().loop?.status).toBe('awaiting-human-pr-approval');
    live = { status: 'awaiting-team-review', iteration: 10, pr: 179, branch: 'b', ready: true, actionable: false, humanNeeded: false };
    expect(flow.state().loop?.status).toBe('awaiting-team-review');
    expect(flow.state().loop?.iteration).toBe(10);
  });
});

// The ticket + PR a flow is working surface as a `refs` field GATED BY FLOW PROGRESS (§24.2.3 T7): the
// github-ticket / pr typed inputs surface only once the step that requests them is entered, and stay
// until a terminate/restart resets the flow. Numbers only — descriptions are fetched lazily by the
// renderer. Refs come from the flow's typed inputs ALONE; the retired engine's state-mirror
// linked_issues/pr fallback went with its bridge (§B.3, recorded as a removed capability in §F).
describe('flow state machine — ticket/PR refs (progress-gated)', () => {
  const APP_LOOP_VIEW: FlowLoopView = { status: 'planning', iteration: 1, pr: null, branch: null, ready: false, actionable: false, humanNeeded: false };
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

  // --- the github-ticket input is gated on entering the step that requests it ---
  it('does NOT surface a persisted github-ticket input value until its step is entered', () => {
    // The value is on disk (inputs are flow-wide), but the flow is still on the pre-input groom step.
    const store = createFlowStateStore(mkdtempSync(join(tmpdir(), 'flow-refs-')));
    store.write({ step: 'groom', status: 'in_progress', inputs: { ticket: '176' } });
    const flow = createFlowMachine(TICKET_FLOW, store);
    expect(flow.state().refs).toBeUndefined();
  });

  it('surfaces the github-ticket input value once its requesting step is entered', () => {
    const store = createFlowStateStore(mkdtempSync(join(tmpdir(), 'flow-refs-')));
    store.write({ step: 'plan', status: 'in_progress', inputs: { ticket: '176' } });
    const flow = createFlowMachine(TICKET_FLOW, store);
    expect(flow.state().refs?.ticket).toBe(176);
  });

  it('omits the ticket ref when the only github-ticket input is non-numeric', () => {
    // numericInput rejects a non-digit value, and there is no other ticket source now — no linked_issues fallback.
    const store = createFlowStateStore(mkdtempSync(join(tmpdir(), 'flow-refs-')));
    store.write({ step: 'plan', status: 'in_progress', inputs: { ticket: 'abc' } });
    const flow = createFlowMachine(TICKET_FLOW, store);
    expect(flow.state().refs).toBeUndefined();
  });

  it('omits refs entirely when no typed input resolves, even on the loop step', () => {
    const flow = createFlowMachine(TICKET_FLOW);
    flow.start();
    flow.advance(); // enter the plan loop step with no input provided
    expect(flow.state().refs).toBeUndefined();
  });

  // --- a pr-typed input surfaces refs.pr, gated on entering its step; no loop needed ---
  const PR_INPUT_FLOW: FlowLoad = {
    ok: true,
    definition: { name: 'f', steps: [{ id: 'review', kind: 'manual', inputs: [{ name: 'thepr', type: 'pr', required: true }] }] },
    flowDir: '/tmp/f/.agent-terminal',
  };

  it('surfaces a pr-typed input value as refs.pr once its step is entered (no loop needed)', () => {
    const store = createFlowStateStore(mkdtempSync(join(tmpdir(), 'flow-refs-')));
    store.write({ step: 'review', status: 'in_progress', inputs: { thepr: '512' } });
    const flow = createFlowMachine(PR_INPUT_FLOW, store);
    expect(flow.state().refs?.pr).toBe(512);
  });

  it('does NOT surface the pr input before its step is entered (not_started)', () => {
    const flow = createFlowMachine(PR_INPUT_FLOW);
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
    const flow = createFlowMachine(PR_INPUT_LATER_FLOW, store);
    expect(flow.state().refs).toBeUndefined(); // on step 'a', before the pr step
    flow.advance(); // enter 'review' (the pr step)
    expect(flow.state().refs?.pr).toBe(512);
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
    const flow = createFlowMachine(TWO_TICKET_FLOW, store);
    expect(flow.state().refs?.ticket).toBe(11);
  });

  // --- the §27 loop view is gated on entering a loop step, and is sticky within the run ---
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

  it('does NOT surface the loop view on a pre-loop manual step', () => {
    const flow = createFlowMachine(STICKY_FLOW, undefined, undefined, () => APP_LOOP_VIEW);
    flow.start(); // on the manual groom step — the loop step has not been entered
    expect(flow.state().loop).toBeUndefined();
  });

  it('keeps the loop view visible on a post-loop manual step (sticky for the run)', () => {
    const flow = createFlowMachine(STICKY_FLOW, undefined, undefined, () => APP_LOOP_VIEW);
    flow.start();
    flow.advance(); // enter build (the loop step) → visible
    flow.advance(); // advance to wrap (a manual step AFTER the loop)
    expect(flow.state().loop).toEqual(APP_LOOP_VIEW);
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
    const flow = createFlowMachine(LOOP_FIRST_FLOW, undefined, undefined, () => APP_LOOP_VIEW);
    const v = flow.state(); // not_started — nothing entered, so the gate is closed
    expect(v.refs).toBeUndefined();
    expect(v.loop).toBeUndefined();
  });

  // Two loop steps bound to DISTINCT §27 defs: the loop view binds to the MOST-RECENTLY-ENTERED loop
  // step, including on a later manual step (a first-wins reduce would surface the wrong loop's view).
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
  const viewA: FlowLoopView = { status: 'planning', iteration: 1, pr: null, branch: null, ready: false, actionable: false, humanNeeded: false, gateOptions: ['approve'] };
  const viewB: FlowLoopView = { status: 'planning', iteration: 1, pr: null, branch: null, ready: false, actionable: false, humanNeeded: false, gateOptions: ['approve', 'impasse'] };

  it('binds the loop view to the most recently entered loop step, across two loops and onto a later manual step', () => {
    const byName = (name: string): FlowLoopView => (name === 'loop-a' ? viewA : viewB);
    const flow = createFlowMachine(TWO_LOOP_FLOW, undefined, undefined, byName);
    flow.start(); // first (loop-a)
    expect(flow.state().loop?.gateOptions).toEqual(['approve']);
    flow.advance(); // second (loop-b)
    expect(flow.state().loop?.gateOptions).toEqual(['approve', 'impasse']);
    flow.advance(); // wrap (manual, post-loop) → still loop-b, the most-recently-entered loop
    expect(flow.state().loop?.gateOptions).toEqual(['approve', 'impasse']);
  });

  // Terminate/Restart reset the flow to its first step, closing every progress gate: the prior run's
  // ticket/PR display and loop view clear with NO state write and stay clear until the flow re-enters a
  // loop step (§24.2.3 T7).
  describe('terminate/restart close the progress gates', () => {
    it('terminate() clears the typed-input refs and the loop view', () => {
      const store = createFlowStateStore(mkdtempSync(join(tmpdir(), 'flow-refs-')));
      store.write({ step: 'plan', status: 'in_progress', inputs: { ticket: '176' } });
      const flow = createFlowMachine(TICKET_FLOW, store, undefined, () => APP_LOOP_VIEW);
      expect(flow.state().refs).toEqual({ ticket: 176 });
      expect(flow.state().loop).toEqual(APP_LOOP_VIEW);
      flow.terminate();
      const after = flow.state();
      expect(after.refs).toBeUndefined();
      expect(after.loop).toBeUndefined();
    });

    it('restart() clears the loop view until the loop step is re-entered', () => {
      const flow = createFlowMachine(TICKET_FLOW, undefined, undefined, () => APP_LOOP_VIEW);
      flow.start();
      flow.advance(); // enter the loop step → visible
      flow.advance(); // → done (past the last step)
      expect(flow.state().loop).toEqual(APP_LOOP_VIEW);
      flow.restart(); // → in_progress at the groom step; the loop step is no longer entered
      expect(flow.state().loop).toBeUndefined();
      flow.advance(); // re-enter the loop step → the loop view is shown again
      expect(flow.state().loop).toEqual(APP_LOOP_VIEW);
    });

    it('does NOT re-reveal the loop view while the provider still answers after a terminate', () => {
      // The §27 provider keeps answering (the underlying loop is still running), but with the flow at
      // not_started and no loop step entered, the display must stay clear.
      const flow = createFlowMachine(TICKET_FLOW, undefined, undefined, () => APP_LOOP_VIEW);
      flow.start();
      flow.advance();
      expect(flow.state().loop).toEqual(APP_LOOP_VIEW);
      flow.terminate();
      expect(flow.state().loop).toBeUndefined();
    });

    it('surfaces a typed-input ticket provided after restart once its requesting step is re-entered', () => {
      const flow = createFlowMachine(TICKET_FLOW);
      flow.start();
      flow.advance();
      flow.advance(); // → done
      flow.restart(); // returns to the groom step and clears inputs
      expect(flow.state().refs).toBeUndefined();
      flow.advance(); // re-enter the plan step (which requests the ticket)
      flow.provideInput({ ticket: '99' }); // a fresh, flow-owned ticket
      expect(flow.state().refs).toEqual({ ticket: 99 });
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

  it('resolveInputs persists the value WITHOUT re-entering the step (§28.4.1 programmatic sourcing, not a prompt answer)', () => {
    const store = createFlowStateStore(dir);
    const flow = createFlowMachine(LOAD, store, bootEnter);
    flow.start();
    bootEnter.mockClear();
    flow.resolveInputs({ slices: '3' });
    // Unlike provideInput (which answers a step-entry prompt and re-enters), resolveInputs sets the input quietly:
    // the plan-bundle gate resolves `slices` for the DOWNSTREAM refactor step, so re-entering plan-bundle here
    // would wrongly restart its loop.
    expect(bootEnter).not.toHaveBeenCalled();
    expect(store.read()?.inputs).toEqual({ slices: '3' });
  });

  it('resolveInputs is illegal unless a step is being worked (in_progress)', () => {
    const flow = createFlowMachine(LOAD, undefined, bootEnter);
    expect(() => flow.resolveInputs({ slices: '3' })).toThrow();
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
    const store = memStore(
      () => stored,
      (s) => (stored = s),
    );
    const flow = createFlowMachine(THREE_STEP, store);
    expect(flow.state().stepName).toBe('groom');
    stored = { step: 'implement', status: 'in_progress' }; // external advance on disk
    expect(flow.state().stepName).toBe('implement');
    expect(flow.state().status).toBe('in_progress');
  });

  it('reflects a flow-state.yaml deleted out from under it as not_started', () => {
    let stored: PersistedFlowState | null = { step: 'implement', status: 'in_progress' };
    const store = memStore(
      () => stored,
      (s) => (stored = s),
    );
    const flow = createFlowMachine(THREE_STEP, store);
    expect(flow.state().status).toBe('in_progress');
    stored = null; // file removed/cleared on disk
    const s = flow.state();
    expect(s.status).toBe('not_started');
    expect(s.stepName).toBe('groom'); // back to the first step
  });
});

// §28.4 loop-back (repeat) primitive — the flow-machine mechanism §28.2's slice-loop×N needs. A step
// carrying `repeat: { backTo, countInput }` turns advance() OFF that step into a conditional back-jump:
// while it has looped back fewer than `count` times (the value of the `countInput` flow input, the slice
// count the plan decides), `index` jumps to `backTo`; otherwise advance() falls through as normal. The
// observable contract is purely the step sequence advance() produces and what survives a relaunch — never
// which private counter moved. Count is clamped [1, MAX_SLICES] so untrusted plan data can neither disable
// the loop nor run it unbounded (CWE-20/770).
describe('flow machine loop-back (repeat) primitive (§28.4 — impl-slice×N)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-repeat-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // plan → red → green → refactor(repeat back_to=red, count_input=slices) → finalize
  const repeatLoad: FlowLoad = {
    ok: true,
    definition: {
      name: 'f',
      steps: [
        { id: 'plan', kind: 'manual' },
        { id: 'red', kind: 'manual' },
        { id: 'green', kind: 'manual' },
        { id: 'refactor', kind: 'manual', repeat: { backTo: 'red', countInput: 'slices' } },
        { id: 'finalize', kind: 'manual' },
      ],
    },
    flowDir: '/tmp/f/.agent-terminal',
  };

  /** Advance to `done` (or a generous budget guarding against a runaway), counting how many times each
   *  named step is entered — the only thing a caller can observe about the loop-back. */
  const runCounting = (flow: ReturnType<typeof createFlowMachine>): Record<string, number> => {
    const visits: Record<string, number> = {};
    for (let i = 0; i < 10 * MAX_SLICES && flow.state().status !== 'done'; i++) {
      const s = flow.state().stepName;
      visits[s] = (visits[s] ?? 0) + 1;
      flow.advance();
    }
    return visits;
  };

  it('loops back to back_to once per slice until the count is reached, then falls through to done', () => {
    const flow = createFlowMachine(repeatLoad, createFlowStateStore(dir));
    flow.start();
    flow.provideInput({ slices: '3' });
    const visits = runCounting(flow);
    expect(flow.state().status).toBe('done');
    expect(visits.red).toBe(3); // red re-entered once per slice
    expect(visits.refactor).toBe(3);
    expect(visits.finalize).toBe(1); // reached exactly once, after the last slice
  });

  it('advances a repeat step only once when no slice count is resolved (count defaults to 1 — no runaway)', () => {
    const flow = createFlowMachine(repeatLoad, createFlowStateStore(dir));
    flow.start(); // no provideInput: `slices` is unset
    const visits = runCounting(flow);
    expect(flow.state().status).toBe('done');
    expect(visits.red).toBe(1);
    expect(visits.refactor).toBe(1);
  });

  it('currentSlice() reports the impl-slice in progress — 1 at first RED, incrementing on each loop-back', () => {
    const flow = createFlowMachine(repeatLoad, createFlowStateStore(dir));
    flow.start(); // plan
    flow.provideInput({ slices: '3' });
    flow.advance(); // → red (slice 1)
    expect([flow.state().stepName, flow.currentSlice()]).toEqual(['red', 1]);
    flow.advance(); // → green
    flow.advance(); // → refactor
    flow.advance(); // loops back → red (slice 2)
    expect([flow.state().stepName, flow.currentSlice()]).toEqual(['red', 2]);
    flow.advance(); // → green
    flow.advance(); // → refactor
    flow.advance(); // loops back → red (slice 3)
    expect([flow.state().stepName, flow.currentSlice()]).toEqual(['red', 3]);
  });

  it('currentSlice() is 1 for a flow with no repeat step (the unsliced default)', () => {
    const noRepeat: FlowLoad = {
      ok: true,
      definition: { name: 'f', steps: [{ id: 'a', kind: 'manual' }, { id: 'b', kind: 'manual' }] },
      flowDir: '/tmp/f/.agent-terminal',
    };
    const flow = createFlowMachine(noRepeat, createFlowStateStore(dir));
    flow.start();
    flow.advance();
    expect(flow.currentSlice()).toBe(1);
  });

  it('clamps an over-cap slice count to MAX_SLICES (a plan cannot drive an unbounded loop, CWE-770)', () => {
    const flow = createFlowMachine(repeatLoad, createFlowStateStore(dir));
    flow.start();
    flow.provideInput({ slices: String(MAX_SLICES + 25) });
    const visits = runCounting(flow);
    expect(flow.state().status).toBe('done');
    expect(visits.refactor).toBe(MAX_SLICES);
  });

  it('treats a non-integer / negative slice count as 1 (validated at the read boundary, CWE-20)', () => {
    for (const bad of ['-5', 'abc', '', '2.5']) {
      const d = mkdtempSync(join(tmpdir(), 'flow-repeat-bad-'));
      const flow = createFlowMachine(repeatLoad, createFlowStateStore(d));
      flow.start();
      flow.provideInput({ slices: bad });
      const visits = runCounting(flow);
      expect(visits.refactor).toBe(1);
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('persists the repeat iteration so a relaunch resumes the same slice, not slice 1', () => {
    const flow1 = createFlowMachine(repeatLoad, createFlowStateStore(dir));
    flow1.start();
    flow1.provideInput({ slices: '3' });
    flow1.advance(); // red (slice 1)
    flow1.advance(); // green
    flow1.advance(); // refactor (slice 1)
    flow1.advance(); // loop back → red (slice 2)
    expect(flow1.state().stepName).toBe('red');

    // A fresh machine over the same on-disk state must know it is on slice 2: only slices 2 and 3 remain,
    // so refactor is entered exactly twice more — not three times (which is what a lost counter would do).
    const flow2 = createFlowMachine(repeatLoad, createFlowStateStore(dir));
    const visits = runCounting(flow2);
    expect(flow2.state().status).toBe('done');
    expect(visits.refactor).toBe(2);
  });

  it('restart() clears the repeat counters so the next run loops afresh', () => {
    const store = createFlowStateStore(dir);
    const flow = createFlowMachine(repeatLoad, store);
    flow.start();
    flow.provideInput({ slices: '2' });
    runCounting(flow); // run one full 2-slice pass to done
    expect(flow.state().status).toBe('done');

    flow.restart(); // done → in_progress at the first step, counters and inputs cleared
    flow.provideInput({ slices: '2' });
    const visits = runCounting(flow);
    expect(visits.refactor).toBe(2); // loops again, not stuck at the exhausted prior count
  });

  it('terminate() clears the repeat counters so a fresh start loops afresh, not stuck at the exhausted count', () => {
    const flow = createFlowMachine(repeatLoad, createFlowStateStore(dir));
    flow.start();
    flow.provideInput({ slices: '2' });
    runCounting(flow); // run one full 2-slice pass to done
    expect(flow.state().status).toBe('done');

    flow.terminate(); // done → not_started; an abandoned flow carries no loop-back state forward
    expect(flow.state().status).toBe('not_started');
    flow.start(); // a fresh run must loop its slices from scratch, not resume the exhausted prior count
    flow.provideInput({ slices: '2' });
    const visits = runCounting(flow);
    expect(visits.refactor).toBe(2); // full count again — a surviving stale counter would force just 1
  });
});

// §28.4.2 manual back-to-RED (reopen the current slice) — the human counterpart to the count-driven
// loop-back. reopenSlice() jumps the flow back to the slice's RED step (the repeat step's `backTo`) WITHOUT
// touching the slice count, so a human who sees the agent stopped short at any phase gate can send it back to
// redo the current iteration's missed work. The count-driven loop-back and this manual reopen must not fight:
// a reopen redoes THIS slice, it does not consume or add one.
describe('flow machine reopen-slice / manual back-to-RED (§28.4.2)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-reopen-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const repeatLoad: FlowLoad = {
    ok: true,
    definition: {
      name: 'f',
      steps: [
        { id: 'plan', kind: 'manual' },
        { id: 'red', kind: 'manual' },
        { id: 'green', kind: 'manual' },
        { id: 'refactor', kind: 'manual', repeat: { backTo: 'red', countInput: 'slices' } },
        { id: 'finalize', kind: 'manual' },
      ],
    },
    flowDir: '/tmp/f/.agent-terminal',
  };

  const countRefactor = (flow: ReturnType<typeof createFlowMachine>): number => {
    let refactor = 0;
    for (let i = 0; i < 10 * MAX_SLICES && flow.state().status !== 'done'; i++) {
      if (flow.state().stepName === 'refactor') refactor++;
      flow.advance();
    }
    return refactor;
  };

  it('jumps the flow back to the slice RED step from any later phase, and re-enters it', () => {
    const flow = createFlowMachine(repeatLoad, createFlowStateStore(dir));
    flow.start();
    flow.provideInput({ slices: '3' });
    flow.advance(); // red (slice 1)
    flow.advance(); // green
    expect(flow.state().stepName).toBe('green');
    expect(flow.reopenSlice().stepName).toBe('red'); // back to RED from the green gate
    expect(flow.state().status).toBe('in_progress');
  });

  it('does NOT consume or add a slice — the reopened slice is redone, then the plan finishes on schedule', () => {
    const flow = createFlowMachine(repeatLoad, createFlowStateStore(dir));
    flow.start();
    flow.provideInput({ slices: '3' });
    flow.advance(); // red (slice 1)
    flow.advance(); // green
    flow.advance(); // refactor (slice 1)
    flow.advance(); // loop back → red (slice 2)
    flow.advance(); // green (slice 2)
    flow.reopenSlice(); // human: back to RED, redo slice 2
    expect(flow.state().stepName).toBe('red');
    // From the reopened slice 2: refactor is entered for slice 2 (redone) then slice 3 = exactly twice more,
    // and the run still ends after slice 3 — the reopen neither consumed slice 2 nor added a fourth.
    expect(countRefactor(flow)).toBe(2);
    expect(flow.state().status).toBe('done');
  });

  it('persists the jump so a relaunch resumes at RED, not where the gate was', () => {
    const flow = createFlowMachine(repeatLoad, createFlowStateStore(dir));
    flow.start();
    flow.provideInput({ slices: '2' });
    flow.advance(); // red
    flow.advance(); // green
    flow.advance(); // refactor
    flow.reopenSlice(); // back to RED (slice 1 still)
    const resumed = createFlowMachine(repeatLoad, createFlowStateStore(dir));
    expect(resumed.state().stepName).toBe('red');
    expect(resumed.state().status).toBe('in_progress');
  });

  it('names the step a slice restarts at, so a caller can tell a landed reopen from an inert one', () => {
    const flow = createFlowMachine(repeatLoad, createFlowStateStore(dir));
    expect(flow.sliceStartStep()).toBe('red');
    const noRepeat: FlowLoad = {
      ok: true,
      definition: { name: 'f', steps: [{ id: 'a', kind: 'manual' }, { id: 'b', kind: 'manual' }] },
      flowDir: '/tmp/f/.agent-terminal',
    };
    expect(createFlowMachine(noRepeat, createFlowStateStore(dir)).sliceStartStep()).toBeNull();
  });

  it('is a no-op when the flow is not in progress', () => {
    const flow = createFlowMachine(repeatLoad, createFlowStateStore(dir));
    expect(flow.reopenSlice().status).toBe('not_started'); // never started
    expect(flow.state().stepName).toBe('plan');
  });

  it('is a no-op for a flow with no repeat step (nothing declares where RED is)', () => {
    const noRepeat: FlowLoad = {
      ok: true,
      definition: { name: 'f', steps: [{ id: 'a', kind: 'manual' }, { id: 'b', kind: 'manual' }] },
      flowDir: '/tmp/f/.agent-terminal',
    };
    const flow = createFlowMachine(noRepeat, createFlowStateStore(dir));
    flow.start();
    flow.advance(); // b
    expect(flow.reopenSlice().stepName).toBe('b'); // unchanged
  });

  it('is a no-op before the slice RED step — a reopen is backward-or-self, never a forward jump', () => {
    const flow = createFlowMachine(repeatLoad, createFlowStateStore(dir));
    flow.start(); // at 'plan', BEFORE the repeat step's back_to ('red')
    expect(flow.state().stepName).toBe('plan');
    expect(flow.reopenSlice().stepName).toBe('plan'); // RED is ahead — a stale reopen must not skip the flow forward
    expect(flow.state().status).toBe('in_progress');
  });

  it('is inert on a load-error machine', () => {
    const flow = createFlowMachine({ ok: false, error: 'no flow.yaml' });
    expect(flow.reopenSlice().status).toBe('error');
  });
});

// §18.7.6 (CWE-116/400) — a load error interpolates repo-authored text (a step id, a kind:, a YAML snippet), so
// the error view echoes it display-safe and length-bounded.
describe('flow state machine — the load-error echo (§18.7.6)', () => {
  it('bounds and sanitizes a load error carrying hostile repo-authored text', () => {
    const hostile = `flow.yaml step "${'s'.repeat(5000)}‍‮" has an unknown kind`;

    const error = createFlowMachine({ ok: false, error: hostile }).state().error ?? '';

    expect(error).toMatch(/flow\.yaml step/);
    expect(error).not.toMatch(/[‍‮]/u);
    expect(error.length).toBeLessThanOrEqual(MAX_ECHOED_LOAD_ERROR_LENGTH);
  });
});
