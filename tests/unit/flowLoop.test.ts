import { describe, expect, it } from 'vitest';
import { deriveLoopView } from '../../src/main/flow';
import type { AgentLoopState } from '../../src/main/agentLoopBridge';
import type { LoopDef } from '../../src/main/loopDef';
import type { FlowStateView } from '../../src/shared/ipc';

// §24.2.3 T2 — deriveLoopView folds the read-only agent-loop state.yaml mirror onto a flow view as a
// `loop` field PARALLEL to S5's `derived` (loop state outlives the manual in_progress window, so it
// is never nested inside derived). When the bound LoopDef resolves, readiness + the gate options are
// GATE-DRIVEN: `ready` is true only at a TERMINAL gate (the loop's exit), and `gateOptions` mirrors
// the current status's gate `human_options`. With no LoopDef it degrades to the documented
// awaiting-human-* "needs you" family and exposes no gate options.

const base: FlowStateView = {
  stepName: 'build',
  steps: ['groom', 'build'],
  position: 2,
  total: 2,
  status: 'in_progress',
};
const loop = (status: string): AgentLoopState => ({ status, iteration: 9, pr: 179, branch: 'b' });

const DEF: LoopDef = {
  name: 'impl-loop',
  gates: [
    { id: 'awaiting-human-pr-approval', kind: 'approve-required', humanOptions: ['approve', 'request-changes', 'impasse'], terminal: false },
    { id: 'awaiting-human-impl-triage', kind: 'triage', humanOptions: ['approve', 'request-changes', 'impasse'], terminal: false },
    { id: 'awaiting-team-review', kind: 'terminal', humanOptions: [], terminal: true },
    { id: 'impasse', kind: 'terminal', humanOptions: [], terminal: true },
  ],
};

describe('deriveLoopView (§24.2.3 T2)', () => {
  it('folds the mirrored loop state onto the view, parallel to derived', () => {
    const v = deriveLoopView(base, loop('awaiting-human-pr-approval'), DEF);
    expect(v.loop).toMatchObject({
      status: 'awaiting-human-pr-approval',
      iteration: 9,
      pr: 179,
      branch: 'b',
      ready: false,
    });
  });

  it('exposes the current gate\'s human_options as gateOptions (gate-driven)', () => {
    expect(deriveLoopView(base, loop('awaiting-human-pr-approval'), DEF).loop?.gateOptions).toEqual([
      'approve',
      'request-changes',
      'impasse',
    ]);
  });

  it('marks the step not-ready at an awaiting gate (the loop has not reached its terminal status)', () => {
    expect(deriveLoopView(base, loop('awaiting-human-pr-approval'), DEF).loop?.ready).toBe(false);
    expect(deriveLoopView(base, loop('awaiting-human-impl-triage'), DEF).loop?.ready).toBe(false);
  });

  it('marks the step not-ready mid-work — a non-gate status means the loop is still running', () => {
    // impl-draft is no gate at all: the loop is iterating, not awaiting the human. The prefix
    // heuristic wrongly called this ready; the gate model does not.
    const v = deriveLoopView(base, loop('impl-draft'), DEF);
    expect(v.loop?.ready).toBe(false);
    expect(v.loop?.gateOptions).toBeUndefined(); // no gate → no options
  });

  it('marks the step ready only at a TERMINAL gate, with no gate options to offer', () => {
    const v = deriveLoopView(base, loop('awaiting-team-review'), DEF);
    expect(v.loop?.ready).toBe(true);
    expect(v.loop?.gateOptions).toBeUndefined();
    expect(deriveLoopView(base, loop('impasse'), DEF).loop?.ready).toBe(true);
  });

  it('degrades to the awaiting-human-* family when the LoopDef does not resolve (no gate options)', () => {
    expect(deriveLoopView(base, loop('awaiting-human-pr-approval'), null).loop?.ready).toBe(false);
    expect(deriveLoopView(base, loop('awaiting-team-review'), null).loop?.ready).toBe(true);
    expect(deriveLoopView(base, loop('awaiting-human-pr-approval'), null).loop?.gateOptions).toBeUndefined();
  });

  it('passes the view through unchanged when there is no mirrored loop state', () => {
    const v = deriveLoopView(base, null, DEF);
    expect(v.loop).toBeUndefined();
    expect(v).toEqual(base);
  });

  it('does not mutate the input view', () => {
    const input: FlowStateView = { ...base };
    deriveLoopView(input, loop('awaiting-human-pr-approval'), DEF);
    expect(input.loop).toBeUndefined();
  });
});
