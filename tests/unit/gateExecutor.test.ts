import { describe, expect, it } from 'vitest';
import { executeGateOutcome, type GateExecDeps } from '../../src/main/gateExecutor';
import type { GateOutcome } from '../../src/main/gateActions';
import type { LoopStateWrite } from '../../src/main/loopStateWriter';

// §26.6 / L5 — the imperative side of the gate transition: given a decided GateOutcome, it writes the
// state.yaml transition, runs the gh side-effects out of band (best-effort), appends the human note, and
// re-iterates (request-changes) or stops (terminal). Tested through injected domain ports — the writes,
// the gh op, and the re-iterate are the observable contract.

function harness(overrides: Partial<GateExecDeps> = {}) {
  const writes: LoopStateWrite[] = [];
  const notes: Array<{ iteration: number; text: string }> = [];
  const readyCalls: number[] = [];
  const reiterations: number[] = [];
  const deps: GateExecDeps = {
    github: { markPrReady: async (pr) => void readyCalls.push(pr) },
    writeState: (s) => void writes.push(s),
    writeHumanNote: (iteration, text) => void notes.push({ iteration, text }),
    reiterate: (nextIteration) => void reiterations.push(nextIteration),
    ...overrides,
  };
  return { deps, writes, notes, readyCalls, reiterations };
}

const CTX = {
  repoDir: '/repo',
  boundLoop: 'plan-loop',
  iteration: 2,
  pr: 42,
  branch: 'plan-loop/issue-1',
  linkedIssues: [1],
  note: 'make it smaller',
};

const approveOutcome: GateOutcome = {
  nextStatus: 'plan-human-approved',
  terminate: true,
  reiterate: false,
  effects: [{ kind: 'mark-pr-ready' }, { kind: 'clear-phase2' }, { kind: 'terminate' }],
};
const requestChangesOutcome: GateOutcome = {
  nextStatus: 'plan-draft',
  terminate: false,
  reiterate: true,
  effects: [{ kind: 'set-phase2', active: true }, { kind: 'clear-persona-state' }, { kind: 'append-human-note' }],
};
const impasseOutcome: GateOutcome = {
  nextStatus: 'impasse',
  terminate: true,
  reiterate: false,
  effects: [{ kind: 'append-human-note' }],
};

describe('executeGateOutcome (§26.6 / L5)', () => {
  it('approve: marks the PR ready, writes the terminal status + terminated, does not re-iterate', async () => {
    const h = harness();
    await executeGateOutcome(approveOutcome, CTX, h.deps);
    expect(h.readyCalls).toEqual([42]);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ status: 'plan-human-approved', iteration: 2, terminated: true });
    expect(h.reiterations).toEqual([]);
  });

  it('request-changes: sets phase2, clears persona_state, writes the human note, re-iterates at +1', async () => {
    const h = harness();
    await executeGateOutcome(requestChangesOutcome, CTX, h.deps);
    expect(h.writes[0]).toMatchObject({
      status: 'plan-draft',
      iteration: 3,
      phase2Active: true,
      clearPersonaState: true,
    });
    expect(h.notes).toEqual([{ iteration: 2, text: 'make it smaller' }]);
    expect(h.reiterations).toEqual([3]);
    expect(h.readyCalls).toEqual([]); // no gh side-effect for request-changes
  });

  it('impasse: writes the human note + terminal impasse status, no gh, no re-iterate', async () => {
    const h = harness();
    await executeGateOutcome(impasseOutcome, CTX, h.deps);
    expect(h.writes[0]).toMatchObject({ status: 'impasse', terminated: true });
    expect(h.notes).toHaveLength(1);
    expect(h.readyCalls).toEqual([]);
    expect(h.reiterations).toEqual([]);
  });

  it('a gh side-effect failure does not abort the transition (best-effort, §26.11)', async () => {
    const h = harness({ github: { markPrReady: async () => { throw new Error('gh offline'); } } });
    await executeGateOutcome(approveOutcome, CTX, h.deps);
    expect(h.writes[0]).toMatchObject({ status: 'plan-human-approved', terminated: true });
  });

  it('does not mark a PR ready when there is no PR number', async () => {
    const h = harness();
    await executeGateOutcome(approveOutcome, { ...CTX, pr: null }, h.deps);
    expect(h.readyCalls).toEqual([]);
    expect(h.writes[0]).toMatchObject({ status: 'plan-human-approved' });
  });
});
