import { describe, expect, it } from 'vitest';
import { classifyHumanNeeded, deriveLoopView } from '../../src/main/flow';
import { isHumanNeededStatus } from '../../src/shared/loopStatus';
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
const loop = (status: string): AgentLoopState => ({ status, iteration: 9, pr: 179, branch: 'b', linkedIssues: [176] });

const DEF: LoopDef = {
  name: 'impl-loop',
  phases: [],
  rosters: [],
  defaultRosterId: '',
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

  it('does not leak AgentLoopState-only fields (linkedIssues) onto the FlowLoopView wire payload', () => {
    // linkedIssues feeds FlowRefs, not the loop mirror; the wire shape (FlowLoopView) must not carry it.
    const v = deriveLoopView(base, loop('awaiting-human-pr-approval'), DEF);
    expect(v.loop && 'linkedIssues' in v.loop).toBe(false);
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
    expect(v.loop?.gateOptions).toBeUndefined();
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

  it('folds the observable human-needed classification onto the loop view', () => {
    expect(deriveLoopView(base, loop('awaiting-human-pr-approval'), DEF).loop?.humanNeeded).toBe(true);
    expect(deriveLoopView(base, loop('awaiting-team-review'), DEF).loop?.humanNeeded).toBe(false);
  });
});

// §24.2.3 T4 — the human-needed classification is the single "needs you" boundary. With a LoopDef it
// keys off the gate model (a non-terminal awaiting gate offering a human decision, plus impasse); with
// no LoopDef it degrades to the shared awaiting-human/impasse family. The shipped vocabulary MUST
// classify identically across both paths (the cross-path-agreement pin), so the cue can never cry wolf
// on a hand-off or stay silent at an impasse.

// The real impl-loop gate model: impasse and awaiting-team-review are BOTH kind:terminal, and
// impl-draft is in-flight yet lists [impasse] as a human option — the three statuses a naive
// gate-field rule misclassifies.
const IMPL_LOOP: LoopDef = {
  name: 'impl-loop',
  phases: [],
  rosters: [],
  defaultRosterId: '',
  gates: [
    { id: 'awaiting-human-pr-approval', kind: 'approve-required', humanOptions: ['approve', 'request-changes', 'impasse'], terminal: false },
    { id: 'awaiting-human-impl-triage', kind: 'triage', humanOptions: ['approve', 'request-changes', 'impasse'], terminal: false },
    { id: 'impl-draft', kind: 'in-flight', humanOptions: ['impasse'], terminal: false },
    { id: 'awaiting-team-review', kind: 'terminal', humanOptions: [], terminal: true },
    { id: 'impasse', kind: 'terminal', humanOptions: [], terminal: true },
  ],
};

const SHIPPED = [
  'awaiting-human-pr-approval',
  'awaiting-human-impl-triage',
  'impl-draft',
  'awaiting-team-review',
  'impasse',
  'thinking',
];

describe('classifyHumanNeeded (§24.2.3 T4)', () => {
  it('flags a LoopDef non-terminal human-decision gate as human-needed', () => {
    expect(classifyHumanNeeded('awaiting-human-pr-approval', IMPL_LOOP)).toBe(true);
    expect(classifyHumanNeeded('awaiting-human-impl-triage', IMPL_LOOP)).toBe(true);
  });

  it('flags an impasse as human-needed even though the LoopDef marks it terminal', () => {
    expect(classifyHumanNeeded('impasse', IMPL_LOOP)).toBe(true);
  });

  it('does not flag the terminal hand-off gate as human-needed', () => {
    expect(classifyHumanNeeded('awaiting-team-review', IMPL_LOOP)).toBe(false);
  });

  it('does not flag an in-flight status that merely lists an impasse option', () => {
    // impl-draft is the loop running; its [impasse] human option must not read as "awaiting you".
    expect(classifyHumanNeeded('impl-draft', IMPL_LOOP)).toBe(false);
  });

  it('does not flag a mid-work status with no gate', () => {
    expect(classifyHumanNeeded('thinking', IMPL_LOOP)).toBe(false);
  });

  it('degrades to the shared family when no LoopDef resolves', () => {
    expect(classifyHumanNeeded('awaiting-human-pr-approval', null)).toBe(true);
    expect(classifyHumanNeeded('impasse', null)).toBe(true);
    expect(classifyHumanNeeded('awaiting-team-review', null)).toBe(false);
    expect(classifyHumanNeeded('impl-draft', null)).toBe(false);
  });

  it('classifies the shipped vocabulary identically with and without the LoopDef', () => {
    for (const status of SHIPPED)
      expect(classifyHumanNeeded(status, IMPL_LOOP)).toBe(classifyHumanNeeded(status, null));
  });

  it('agrees with the shared family predicate on the shipped vocabulary', () => {
    for (const status of SHIPPED)
      expect(classifyHumanNeeded(status, IMPL_LOOP)).toBe(isHumanNeededStatus(status));
  });
});
