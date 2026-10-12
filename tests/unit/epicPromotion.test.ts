import { describe, expect, it, vi } from 'vitest';
import { createEpicPromotionCoordinator, promotionRecordStale, type EpicGateOutcome, type EpicPromotionCoordinatorDeps, type EpicPromotionRefs } from '../../src/main/epicPromotion';
import { gateDecisionAuditCmd, type GateDecider } from '../../src/shared/audit';
import type { LoopDefV2 } from '../../src/main/loopDefV2';
import type { EpicSubTicket } from '../../src/shared/epicPlan';
import type { FlowStateView } from '../../src/shared/ipc';

// §28.7 — the epic-promotion coordinator: a gate-decision-time confirm-first hold (mirrors the §27.10
// bootstrap-conflict coordinator's held/resolve pattern).

// §25 — the caller fires the preview audit iff maybeBegin returned preview-raised; the detection needle both the
// block-string guard and these tests key on is derived from its single producer, never hardcoded (shared-semantics),
// so a rename of the preview cmd re-flows here rather than leaving a stale literal that matches vacuously.
const PREVIEW_AUDIT_CMD = gateDecisionAuditCmd('epic-promotion-preview', 'approve', undefined, 'human');

const DEF = {} as LoopDefV2;
const SUBS: EpicSubTicket[] = [
  { index: 1, title: 'Slice one', body: 'Acceptance criteria: a\n\nplan one' },
  { index: 2, title: 'Slice two', body: 'Acceptance criteria: b\n\nplan two' },
];

function harness(over: Partial<EpicPromotionCoordinatorDeps> = {}) {
  const deps: EpicPromotionCoordinatorDeps = {
    readSubTickets: vi.fn(() => SUBS),
    promotionRecordBlock: vi.fn(() => null),
    emitPreview: vi.fn(),
    runPromotion: vi.fn(() => Promise.resolve()),
    persistAccept: vi.fn(),
    terminateFlow: vi.fn(() => ({ outcome: 'reset' as const, view: {} as FlowStateView })),
    audit: vi.fn(),
    emitError: vi.fn(),
    onViewChanged: vi.fn(),
    ...over,
  };
  return { deps, coord: createEpicPromotionCoordinator(deps) };
}

describe('maybeBegin — intercept an approve on an epic plan (§28.7)', () => {
  it('holds and emits the preview naming every sub-ticket, without accepting', () => {
    const { deps, coord } = harness();
    const outcome = coord.maybeBegin('/repo', DEF, 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle', { epic: 176, pr: 77 });
    expect(outcome).toEqual({ kind: 'preview-raised' });
    expect(deps.emitPreview).toHaveBeenCalledWith({
      repoDir: '/repo', step: 'plan-bundle', epic: 176, pr: 77,
      subTickets: [{ index: 1, title: 'Slice one' }, { index: 2, title: 'Slice two' }],
    });
    expect(deps.persistAccept).not.toHaveBeenCalled(); // held pending confirm — nothing accepted yet
  });

  it('does not intercept a non-epic plan (readSubTickets null)', () => {
    const { deps, coord } = harness({ readSubTickets: vi.fn(() => null) });
    expect(coord.maybeBegin('/repo', DEF, 'l', 's', 't', { epic: 176, pr: 77 })).toEqual({ kind: 'not-epic' });
    expect(deps.emitPreview).not.toHaveBeenCalled();
    expect(deps.emitError).not.toHaveBeenCalled(); // a non-epic plan is not a block — it runs the normal accept
  });
});

// §28.7 / #124 — the authorizing preconditions are checked in maybeBegin BEFORE the preview is raised
// (CODE-STANDARDS policy-checked-at-the-operation). A failed precondition returns `blocked`: an operator error is
// surfaced, NO preview is raised, and no held promotion is registered — so once the condition is corrected a
// fresh approve re-decides the gate cleanly (AC4). The block is audited with a §28-pattern cmd distinct from the
// §25 preview cmd.
describe('maybeBegin — block a precondition failure before the preview (§28.7 / #124)', () => {
  const approveEpic = (coord: ReturnType<typeof harness>['coord'], refs: EpicPromotionRefs = { epic: 176, pr: 77 }): EpicGateOutcome =>
    coord.maybeBegin('/repo', DEF, 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle', refs);

  // The cmd recorded on the most recent block, captured from the audit dep (never the full literal — §3).
  const blockAuditCmd = (deps: EpicPromotionCoordinatorDeps): string => {
    const calls = vi.mocked(deps.audit).mock.calls;
    return calls.length === 0 ? '' : calls[calls.length - 1][1];
  };

  it('Slice 1 — a corrupt promotion record blocks before the preview: error surfaced, block audited, NO preview', () => {
    const { deps, coord } = harness({ promotionRecordBlock: vi.fn(() => 'corrupt' as const) });
    expect(approveEpic(coord)).toEqual({ kind: 'blocked' });
    expect(deps.emitPreview).not.toHaveBeenCalled(); // the confirm-first preview is never raised on a block
    expect(deps.emitError).toHaveBeenCalledWith('/repo', expect.stringContaining('unreadable'));
    expect(blockAuditCmd(deps)).toContain('epic-promotion blocked'); // a §28-pattern block cmd was recorded
    expect(blockAuditCmd(deps)).not.toContain(PREVIEW_AUDIT_CMD); // §25 — the block cmd is NOT the preview cmd
  });

  it('Slice 1 — the gate block predicate is passed the epic issue number the gate resolved and the plan split', () => {
    const promotionRecordBlock = vi.fn(() => 'corrupt' as const);
    const { coord } = harness({ promotionRecordBlock });
    approveEpic(coord, { epic: 176, pr: 77 });
    expect(promotionRecordBlock).toHaveBeenCalledWith('/repo', 176, SUBS);
  });

  it('Slice 1 — AC4: after a corrupt-record block, a corrected record re-decides to preview-raised (gate not stranded)', () => {
    const promotionRecordBlock = vi.fn().mockReturnValueOnce('corrupt').mockReturnValueOnce(null);
    const { deps, coord } = harness({ promotionRecordBlock });
    expect(approveEpic(coord)).toEqual({ kind: 'blocked' }); // first approve blocks
    expect(approveEpic(coord)).toEqual({ kind: 'preview-raised' }); // the record is fixed → the gate re-decides
    expect(deps.emitPreview).toHaveBeenCalledTimes(1); // the preview is raised only on the re-decision
  });

  it('Slice 2 — a well-formed epic plan with an unresolvable epic issue (epic: null) BLOCKS, never silently advances', () => {
    const { deps, coord } = harness();
    expect(approveEpic(coord, { epic: null, pr: 77 })).toEqual({ kind: 'blocked' });
    expect(deps.emitPreview).not.toHaveBeenCalled();
    expect(deps.emitError).toHaveBeenCalledWith('/repo', expect.stringContaining('epic issue'));
    expect(blockAuditCmd(deps)).toContain('epic-promotion blocked'); // a §28-pattern block cmd
    expect(blockAuditCmd(deps)).not.toContain(PREVIEW_AUDIT_CMD); // §25 — the block cmd is NOT the preview cmd
  });

  it('Slice 2 — AC4: after an unresolvable-issue block, a resolvable epic re-decides to preview-raised', () => {
    const { deps, coord } = harness();
    expect(approveEpic(coord, { epic: null, pr: 77 })).toEqual({ kind: 'blocked' });
    expect(approveEpic(coord, { epic: 176, pr: 77 })).toEqual({ kind: 'preview-raised' });
    expect(deps.emitPreview).toHaveBeenCalledTimes(1);
  });

  it('Slice 3 — a readable but STALE promotion record (its split diverges from the plan) BLOCKS before the preview', () => {
    const { deps, coord } = harness({ promotionRecordBlock: vi.fn(() => 'stale-split' as const) });
    expect(approveEpic(coord)).toEqual({ kind: 'blocked' });
    expect(deps.emitPreview).not.toHaveBeenCalled(); // never prompt-then-refuse: no confirm-first preview on a stale record
    expect(deps.emitError).toHaveBeenCalledWith('/repo', expect.stringContaining('plan changed since a partial promotion'));
    expect(blockAuditCmd(deps)).toContain('epic-promotion blocked'); // a §28-pattern block cmd
    expect(blockAuditCmd(deps)).not.toContain(PREVIEW_AUDIT_CMD); // §25 — the block cmd is NOT the preview cmd
  });

  it('Slice 3 — the stale-record block cmd is DISTINCT from the corrupt-record block cmd (§25 — the two outcomes stay distinguishable)', () => {
    const stale = harness({ promotionRecordBlock: vi.fn(() => 'stale-split' as const) });
    const corrupt = harness({ promotionRecordBlock: vi.fn(() => 'corrupt' as const) });
    approveEpic(stale.coord);
    approveEpic(corrupt.coord);
    expect(blockAuditCmd(stale.deps)).not.toBe(blockAuditCmd(corrupt.deps));
  });

  it('Slice 3 — AC4: after a stale-record block, a reconciled record re-decides to preview-raised', () => {
    const promotionRecordBlock = vi.fn().mockReturnValueOnce('stale-split').mockReturnValueOnce(null);
    const { deps, coord } = harness({ promotionRecordBlock });
    expect(approveEpic(coord)).toEqual({ kind: 'blocked' });
    expect(approveEpic(coord)).toEqual({ kind: 'preview-raised' });
    expect(deps.emitPreview).toHaveBeenCalledTimes(1);
  });
});

// #137 AC7 — pinning: every `§28 epic-promotion` entry the coordinator writes, byte-for-byte as at 8f03f066.
describe('pinning: the coordinator\'s epic-promotion audit entries (#137 AC7)', () => {
  const approveEpic = (coord: ReturnType<typeof harness>['coord'], refs: EpicPromotionRefs = { epic: 176, pr: 77 }): EpicGateOutcome =>
    coord.maybeBegin('/repo', DEF, 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle', refs);
  const entries = (deps: EpicPromotionCoordinatorDeps): [string, number | null][] => vi.mocked(deps.audit).mock.calls.map(([, cmd, exit]) => [cmd, exit]);

  it.each([
    ['corrupt' as const, '§28 epic-promotion blocked — unreadable promotion record'],
    ['stale-split' as const, '§28 epic-promotion blocked — plan diverged from partial-promotion record'],
  ])('a %s promotion record writes the blocked entry', (block, literal) => {
    const { deps, coord } = harness({ promotionRecordBlock: vi.fn(() => block) });
    approveEpic(coord);
    expect(entries(deps)).toEqual([[literal, 1]]);
  });

  it('an unresolvable epic issue writes the blocked entry', () => {
    const { deps, coord } = harness();
    approveEpic(coord, { epic: null, pr: 77 });
    expect(entries(deps)).toEqual([['§28 epic-promotion blocked — unresolvable epic issue', 1]]);
  });

  it('a declined promotion writes the declined entry', async () => {
    const { deps, coord } = harness();
    approveEpic(coord);
    await coord.resolve('/repo', 'plan-bundle', false);
    expect(entries(deps)).toEqual([['§28 epic-promotion declined', 0]]);
  });

  it('a confirmed promotion writes the confirm entry', async () => {
    const { deps, coord } = harness();
    approveEpic(coord);
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(entries(deps)).toEqual([['§28 epic-promotion', 0]]);
  });

  it('a refused Terminate after the confirm writes the terminate-failed entry with its reason', async () => {
    const { deps, coord } = harness({
      terminateFlow: vi.fn(() => ({ outcome: 'refused' as const, cause: 'locked' as const, reason: 'a peer holds the worktree lock', view: {} as FlowStateView })),
    });
    approveEpic(coord);
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(entries(deps)).toEqual([['§28 epic-promotion', 0], ['§28 epic-promotion terminate failed: a peer holds the worktree lock', 1]]);
  });

  it('a throwing Terminate after the confirm writes the terminate-failed entry with the error', async () => {
    const { deps, coord } = harness({
      terminateFlow: vi.fn(() => {
        throw new Error('illegal flow transition');
      }),
    });
    approveEpic(coord);
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(entries(deps)).toEqual([['§28 epic-promotion', 0], ['§28 epic-promotion terminate failed: illegal flow transition', 1]]);
  });
});

// #137 AC8 — an engine-decided approve's blocked entry is marked; a human one is the pinned literal.
describe('the coordinator\'s blocked entries carry the decider (§27.9.1 N9b.9, #137 AC8)', () => {
  const blockedBy = (decider: GateDecider, over: Partial<EpicPromotionCoordinatorDeps>, refs: EpicPromotionRefs = { epic: 176, pr: 77 }): [string, number | null][] => {
    const { deps, coord } = harness(over);
    coord.maybeBegin('/repo', DEF, 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle', refs, decider);
    return vi.mocked(deps.audit).mock.calls.map(([, cmd, exit]) => [cmd, exit]);
  };

  it.each([
    ['a corrupt record', { promotionRecordBlock: vi.fn(() => 'corrupt' as const) }, undefined, 'blocked — unreadable promotion record'],
    ['a stale record', { promotionRecordBlock: vi.fn(() => 'stale-split' as const) }, undefined, 'blocked — plan diverged from partial-promotion record'],
    ['an unresolvable epic issue', {}, { epic: null, pr: 77 }, 'blocked — unresolvable epic issue'],
  ] as [string, Partial<EpicPromotionCoordinatorDeps>, EpicPromotionRefs | undefined, string][])('%s: engine-decided is marked, human is unmarked', (_name, over, refs, tail) => {
    expect(blockedBy('engine', over, refs)).toEqual([[`§28 epic-promotion (engine-decided) ${tail}`, 1]]);
    expect(blockedBy('human', over, refs)).toEqual([[`§28 epic-promotion ${tail}`, 1]]);
  });

  it.each([
    ['a confirm', {}, true, [['§28 epic-promotion', 0]]],
    ['a decline', {}, false, [['§28 epic-promotion declined', 0]]],
    [
      'a confirm whose Terminate is refused',
      { terminateFlow: vi.fn(() => ({ outcome: 'refused' as const, cause: 'locked' as const, reason: 'a peer holds the worktree lock', view: {} as FlowStateView })) },
      true,
      [['§28 epic-promotion', 0], ['§28 epic-promotion terminate failed: a peer holds the worktree lock', 1]],
    ],
  ] as [string, Partial<EpicPromotionCoordinatorDeps>, boolean, [string, number][]][])(
    'an engine-begun preview resolved by %s from the operator writes unmarked entries (N9b.9)',
    async (_name, over, confirm, expected) => {
      const { deps, coord } = harness(over);
      coord.maybeBegin('/repo', DEF, 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle', { epic: 176, pr: 77 }, 'engine');
      await coord.resolve('/repo', 'plan-bundle', confirm);
      expect(vi.mocked(deps.audit).mock.calls.map(([, cmd, exit]) => [cmd, exit])).toEqual(expected);
    },
  );
});

describe('promotionRecordStale — a resumed record reconciled against the current plan (§28.7)', () => {
  it('is not stale when every recorded sub-ticket is still present at the same index AND title', () => {
    expect(promotionRecordStale([{ index: 1, title: 'Slice one' }, { index: 2, title: 'Slice two' }], SUBS)).toBe(false);
  });
  it('is stale when a recorded sub-ticket title diverges from the plan', () => {
    expect(promotionRecordStale([{ index: 1, title: 'Renamed slice' }], SUBS)).toBe(true);
  });
  it('is stale when a recorded index is absent from the plan (a slice was removed or reordered)', () => {
    expect(promotionRecordStale([{ index: 9, title: 'Slice one' }], SUBS)).toBe(true);
  });
  it('an empty record (a fresh promotion) is never stale', () => {
    expect(promotionRecordStale([], SUBS)).toBe(false);
  });
});

describe('resolve — complete the held promotion (§28.7)', () => {
  const begin = (coord: ReturnType<typeof harness>['coord']): EpicGateOutcome =>
    coord.maybeBegin('/repo', DEF, 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle', { epic: 176, pr: 77 });

  it('confirm runs the promotion then persists the accept + stands the flow down', async () => {
    const { deps, coord } = harness();
    begin(coord);
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(deps.runPromotion).toHaveBeenCalledWith('/repo', { epic: 176, pr: 77, subTickets: SUBS });
    expect(deps.persistAccept).toHaveBeenCalledWith('/repo', 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle');
    expect(deps.terminateFlow).toHaveBeenCalledWith('/repo');
    expect(deps.audit).toHaveBeenCalledWith('/repo', '§28 epic-promotion', 0);
    expect(deps.onViewChanged).toHaveBeenCalled();
  });

  it('decline drops the promotion and leaves the gate — nothing promoted, nothing accepted', async () => {
    const { deps, coord } = harness();
    begin(coord);
    await coord.resolve('/repo', 'plan-bundle', false);
    expect(deps.runPromotion).not.toHaveBeenCalled();
    expect(deps.persistAccept).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith('/repo', '§28 epic-promotion declined', 0);
    expect(deps.onViewChanged).toHaveBeenCalled(); // re-render the still-actionable gate
  });

  it('a resolve with no pending promotion is inert (a raced/stale answer)', async () => {
    const { deps, coord } = harness();
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(deps.runPromotion).not.toHaveBeenCalled();
    expect(deps.persistAccept).not.toHaveBeenCalled();
  });

  it('a second resolve after the first is inert (the hold is cleared once answered)', async () => {
    const { deps, coord } = harness();
    begin(coord);
    await coord.resolve('/repo', 'plan-bundle', true);
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(deps.runPromotion).toHaveBeenCalledTimes(1);
    expect(deps.persistAccept).toHaveBeenCalledTimes(1);
  });

  it('re-reads the plan at confirm (re-authorization): a plan no longer epic aborts without accepting', async () => {
    const readSubTickets = vi.fn().mockReturnValueOnce(SUBS).mockReturnValueOnce(null);
    const { deps, coord } = harness({ readSubTickets });
    begin(coord);
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(deps.runPromotion).not.toHaveBeenCalled();
    expect(deps.persistAccept).not.toHaveBeenCalled();
    expect(deps.emitError).toHaveBeenCalled();
  });

  it('binds confirm to the previewed split: a changed split aborts without promoting (CWE-367)', async () => {
    const OTHER: EpicSubTicket[] = [{ index: 1, title: 'A different slice', body: 'Acceptance criteria: z' }];
    const readSubTickets = vi.fn().mockReturnValueOnce(SUBS).mockReturnValueOnce(OTHER);
    const { deps, coord } = harness({ readSubTickets });
    begin(coord);
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(deps.runPromotion).not.toHaveBeenCalled();
    expect(deps.persistAccept).not.toHaveBeenCalled();
    expect(deps.emitError).toHaveBeenCalledWith('/repo', expect.stringContaining('changed since you reviewed'));
  });

  it('a promotion failure keeps the gate un-accepted (never persisted) and surfaces as a promotion error', async () => {
    const { deps, coord } = harness({ runPromotion: vi.fn(() => Promise.reject(new Error('gh exploded'))) });
    begin(coord);
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(deps.persistAccept).not.toHaveBeenCalled(); // the approved plan is not lost — gate re-decidable
    expect(deps.terminateFlow).not.toHaveBeenCalled();
    expect(deps.emitError).toHaveBeenCalledWith('/repo', expect.stringContaining('epic promotion failed'));
    expect(deps.audit).not.toHaveBeenCalledWith('/repo', '§28 epic-promotion', 0);
  });

  it('D48: a persist failure after a successful promotion surfaces as a PERSIST error, not a promotion failure', async () => {
    const { deps, coord } = harness({
      persistAccept: vi.fn(() => {
        throw new Error('§27 loop area is unresolvable');
      }),
    });
    begin(coord);
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(deps.runPromotion).toHaveBeenCalled();
    expect(deps.terminateFlow).not.toHaveBeenCalled(); // aborted at persist
    expect(deps.emitError).toHaveBeenCalledWith('/repo', expect.stringContaining('could not persist gate accept'));
    expect(deps.emitError).not.toHaveBeenCalledWith('/repo', expect.stringContaining('epic promotion failed'));
  });

  it('a terminate failure after a persisted accept is best-effort — the accept stands, no promotion error', async () => {
    const { deps, coord } = harness({
      terminateFlow: vi.fn(() => {
        throw new Error('illegal flow transition');
      }),
    });
    begin(coord);
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(deps.persistAccept).toHaveBeenCalled(); // the gate is accepted
    expect(deps.emitError).not.toHaveBeenCalledWith('/repo', expect.stringContaining('epic promotion failed'));
  });

  it.each(['locked', 'failed'] as const)('A3 T6b: a Terminate refused as %s records the "terminate failed" audit entry with its reason', async (cause) => {
    const { deps, coord } = harness({
      terminateFlow: vi.fn(() => ({ outcome: 'refused' as const, cause, reason: 'a peer holds the worktree lock', view: {} as FlowStateView })),
    });
    begin(coord);
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(deps.audit).toHaveBeenCalledWith('/repo', expect.stringMatching(/terminate failed.*a peer holds the worktree lock/), 1);
  });

  it('A3 T6b: a Terminate refused as not-begun records no "terminate failed" entry (nothing needed terminating)', async () => {
    const { deps, coord } = harness({
      terminateFlow: vi.fn(() => ({ outcome: 'refused' as const, cause: 'not-begun' as const, view: {} as FlowStateView })),
    });
    begin(coord);
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(deps.audit).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/terminate failed/), expect.anything());
  });
});

// §28.7 slice C — the promotion executor: create each sub-ticket in order (the plan slice VERBATIM + the epic
// link + the REAL preceding issue number), uniform labels, then append the epic's tracking checklist, then
// close the epic planning PR. The gh port is injected so the sequence is asserted with no real gh.
import { runEpicPromotion, type AppEpicPromotionGitHub, type EpicPromotionStore } from '../../src/main/epicPromotion';
import type { EpicPromotionState } from '../../src/main/appLoopState';

function fakeGh(start = 500) {
  const events: string[] = [];
  let next = start;
  const gh: AppEpicPromotionGitHub = {
    ensureLabel: async () => {},
    createIssue: async (title, body) => {
      next += 1;
      events.push(`create#${next} title=${title} body=${JSON.stringify(body)}`);
      return next;
    },
    addLabel: async (issue, label) => void events.push(`label #${issue} ${label}`),
    appendIssueBody: async (issue, text) => void events.push(`append #${issue} ${JSON.stringify(text)}`),
    closePr: async (pr) => void events.push(`closePr #${pr}`),
  };
  return { gh, events };
}

// A gh fake that rejects createIssue on the Nth call (1-based), to prove partial-failure records what landed.
function failingGh(failCreateOn: number) {
  const events: string[] = [];
  let next = 500;
  let creates = 0;
  const gh: AppEpicPromotionGitHub = {
    ensureLabel: async () => {},
    createIssue: async (title, body) => {
      creates += 1;
      if (creates === failCreateOn) throw new Error('gh create failed');
      next += 1;
      events.push(`create#${next} title=${title} body=${JSON.stringify(body)}`);
      return next;
    },
    addLabel: async (issue, label) => void events.push(`label #${issue} ${label}`),
    appendIssueBody: async (issue) => void events.push(`append #${issue}`),
    closePr: async (pr) => void events.push(`closePr #${pr}`),
  };
  return { gh, events };
}

// An in-memory promotion store: seed with a resumable record, or 'corrupt' to exercise the block. `saved` holds
// the last written state so a test can assert what was persisted.
function memStore(initial: EpicPromotionState | 'corrupt' | null = null): { store: EpicPromotionStore; saved: () => EpicPromotionState | null } {
  const corrupt = initial === 'corrupt';
  let held: EpicPromotionState | null = corrupt ? null : initial;
  return {
    store: {
      read: (epic) => (corrupt ? 'corrupt' : held && held.epic === epic ? held : null),
      write: (state) => void (held = state),
    },
    saved: () => held,
  };
}

const REQUEST = {
  epic: 176,
  pr: 4242,
  subTickets: [
    { index: 1, title: 'Slice one', body: 'Acceptance criteria: a\n\nPLAN-ONE build it end to end.' },
    { index: 2, title: 'Slice two', body: 'Acceptance criteria: b\n\nPLAN-TWO tear it down.' },
  ],
};

describe('runEpicPromotion — create the chain + tracking issue (§28.7 AC2)', () => {
  it('creates each sub-ticket carrying its plan slice verbatim, the epic link, and the REAL preceding number', async () => {
    const { gh, events } = fakeGh();
    await runEpicPromotion(gh, REQUEST, memStore().store);
    const create1 = events.find((e) => e.startsWith('create#501'))!;
    const create2 = events.find((e) => e.startsWith('create#502'))!;
    expect(create1).toContain('PLAN-ONE build it end to end.'); // plan slice preserved verbatim
    expect(create1).toContain('Epic: #176');
    expect(create1).toContain('Preceding sub-ticket: none'); // the first slice stacks on nothing
    expect(create2).toContain('PLAN-TWO tear it down.');
    // the REAL preceding issue number, in a token DISTINCT from the plan's own authored `Depends on:` ordinal
    expect(create2).toContain('Preceding sub-ticket: #501');
  });

  it('labels every sub-ticket uniformly agent-loop/subticket + agent-loop/ready (the port has no assign verb)', async () => {
    const { gh, events } = fakeGh();
    await runEpicPromotion(gh, REQUEST, memStore().store);
    for (const issue of [501, 502]) {
      expect(events).toContain(`label #${issue} agent-loop/subticket`);
      expect(events).toContain(`label #${issue} agent-loop/ready`);
    }
  });

  it('appends a tracking checklist naming every created sub-ticket to the epic, then closes the planning PR', async () => {
    const { gh, events } = fakeGh();
    await runEpicPromotion(gh, REQUEST, memStore().store);
    const append = events.find((e) => e.startsWith('append #176'))!;
    expect(append).toContain('- [ ] #501 — Slice one');
    expect(append).toContain('- [ ] #502 — Slice two');
    expect(events).toContain('closePr #4242');
  });

  it('orders create → epic-append → close (the plan is never lost)', async () => {
    const { gh, events } = fakeGh();
    await runEpicPromotion(gh, REQUEST, memStore().store);
    const lastCreate = Math.max(...events.map((e, i) => (e.startsWith('create#') ? i : -1)));
    const append = events.findIndex((e) => e.startsWith('append #176'));
    const close = events.findIndex((e) => e.startsWith('closePr'));
    expect(lastCreate).toBeGreaterThan(-1); // a create actually happened (not a vacuous -1 < close)
    expect(append).toBeGreaterThan(lastCreate);
    expect(close).toBeGreaterThan(append);
  });

  it('does not close a PR when the epic has no planning PR', async () => {
    const { gh, events } = fakeGh();
    await runEpicPromotion(gh, { ...REQUEST, pr: null }, memStore().store);
    expect(events.some((e) => e.startsWith('closePr'))).toBe(false);
  });

  it('records each created sub-ticket (with its title) + the flags in the store (resumable)', async () => {
    const { gh } = fakeGh();
    const m = memStore();
    await runEpicPromotion(gh, REQUEST, m.store);
    expect(m.saved()).toEqual({
      epic: 176,
      created: [{ index: 1, issue: 501, title: 'Slice one' }, { index: 2, issue: 502, title: 'Slice two' }],
      trackingAppended: true,
      prClosed: true,
    });
  });
});

const REC1 = { index: 1, issue: 501, title: 'Slice one' };
const REC2 = { index: 2, issue: 502, title: 'Slice two' };

describe('runEpicPromotion — resumable idempotency (§28.7 AC3)', () => {
  it('creates NOTHING when the store already records the whole chain (a clean re-run)', async () => {
    const { gh, events } = fakeGh();
    const done = memStore({ epic: 176, created: [REC1, REC2], trackingAppended: true, prClosed: true });
    await runEpicPromotion(gh, REQUEST, done.store);
    expect(events.filter((e) => e.startsWith('create#'))).toEqual([]); // no sub-ticket re-created
    expect(events.some((e) => e.startsWith('append'))).toBe(false); // no re-append
    expect(events.some((e) => e.startsWith('closePr'))).toBe(false); // no re-close
  });

  it('creates ONLY the missing sub-tickets after a partial run (resume), preserving the real stacking number', async () => {
    const { gh, events } = fakeGh(600); // seed the counter ABOVE the recorded #501 so a real reuse-of-stale-number bug can't hide behind a collision
    const partial = memStore({ epic: 176, created: [REC1], trackingAppended: false, prClosed: false });
    await runEpicPromotion(gh, REQUEST, partial.store);
    expect(events.filter((e) => e.startsWith('create#'))).toHaveLength(1); // only #2 is created, as a fresh #601
    expect(events.find((e) => e.startsWith('create#'))).toContain('create#601'); // its OWN new number, distinct from the recorded #501
    expect(events.find((e) => e.startsWith('create#'))).toContain('Preceding sub-ticket: #501'); // stacks on recorded #501
    const append = events.find((e) => e.startsWith('append #176'))!;
    expect(append).toContain('- [ ] #501 — Slice one'); // checklist names the recorded slice
    expect(append).toContain('- [ ] #601 — Slice two'); // …and the freshly-created one, by its real new number
    expect(events).toContain('closePr #4242');
  });

  it('resumes after the append but before the close — closes the PR without re-appending (independent flags)', async () => {
    const { gh, events } = fakeGh();
    const afterAppend = memStore({ epic: 176, created: [REC1, REC2], trackingAppended: true, prClosed: false });
    await runEpicPromotion(gh, REQUEST, afterAppend.store);
    expect(events.some((e) => e.startsWith('append'))).toBe(false); // the append is NOT repeated
    expect(events).toContain('closePr #4242'); // but the close still happens
  });

  it('records a created sub-ticket BEFORE labelling it — a label failure never loses the issue (RELI-D1)', async () => {
    const labelFails: AppEpicPromotionGitHub = { ...fakeGh().gh, createIssue: async () => 501, addLabel: async () => { throw new Error('label failed'); } };
    const m = memStore();
    await expect(runEpicPromotion(labelFails, REQUEST, m.store)).rejects.toThrow(/label failed/);
    // the created issue is already persisted, so a re-run skips its create rather than duplicating it
    expect(m.saved()?.created).toEqual([{ index: 1, issue: 501, title: 'Slice one' }]);
  });

  it('records the FIRST issue even when the SECOND create fails (persist-after-each, not end-of-run)', async () => {
    const { gh, events } = failingGh(2); // createIssue rejects on the 2nd call
    const m = memStore();
    await expect(runEpicPromotion(gh, REQUEST, m.store)).rejects.toThrow(/gh create failed/);
    expect(events.filter((e) => e.startsWith('create#'))).toHaveLength(1); // #1 landed
    expect(m.saved()?.created).toEqual([{ index: 1, issue: 501, title: 'Slice one' }]); // and was recorded before the crash
  });

  it('BLOCKS a resumed record whose split diverged from the current plan (RELI-D3/SEC-D2)', async () => {
    const { gh, events } = fakeGh();
    // the plan was edited: slice 1's title changed since the partial run recorded #501.
    const stale = memStore({ epic: 176, created: [{ index: 1, issue: 501, title: 'An OLD title' }], trackingAppended: false, prClosed: false });
    await expect(runEpicPromotion(gh, REQUEST, stale.store)).rejects.toThrow(/plan changed/);
    expect(events).toEqual([]); // nothing created — never act on a stale split
  });

  it('BLOCKS on a corrupt store — throws, creates nothing (never duplicates public issues, SEC-1)', async () => {
    const { gh, events } = fakeGh();
    await expect(runEpicPromotion(gh, REQUEST, memStore('corrupt').store)).rejects.toThrow(/unreadable/);
    expect(events).toEqual([]);
  });

  it('BLOCKS a request with duplicate sub-ticket indices — refuses rather than collapsing two slices onto one issue', async () => {
    // The executor keys creates on `index`; two sub-tickets sharing an index would create ONE issue and silently
    // drop the other slice's plan. Refuse the malformed split outright (defense-in-depth behind the gate).
    const { gh, events } = fakeGh();
    const dup = {
      epic: 176,
      pr: null,
      subTickets: [
        { index: 1, title: 'Slice A', body: 'Acceptance criteria: a\n\nPLAN-A' },
        { index: 1, title: 'Slice B', body: 'Acceptance criteria: b\n\nPLAN-B' },
      ],
    };
    await expect(runEpicPromotion(gh, dup, memStore().store)).rejects.toThrow(/duplicate/i);
    expect(events).toEqual([]); // nothing created — never drop an approved slice
  });

  it('names the created-but-unrecorded issue when the store write fails after a create (no blind-retry duplicate)', async () => {
    // A = createIssue (public, non-idempotent), B = store.write. If B throws after A, the issue exists on GitHub
    // but is unrecorded; a retry reads a store missing it and re-creates a DUPLICATE. The error must name the
    // orphan so the operator removes it before re-approving (§28.7 AC3; "no unrecoverable state without a route out").
    const { gh } = fakeGh();
    const store: EpicPromotionStore = { read: () => null, write: () => { throw new Error('ENOSPC'); } };
    await expect(runEpicPromotion(gh, REQUEST, store)).rejects.toThrow(/#501/);
  });
});

// §28.7 — GitHub refuses to apply a label the repository does not have, so a repo without the promotion's labels
// used to fail AFTER the first sub-ticket was created, stranding a half-promoted epic. This fake models that rule.
function labelledGitHub(opts: { labels?: string[]; labelCreateFails?: boolean } = {}) {
  const labels = new Set(opts.labels ?? []);
  const issueLabels = new Map<number, Set<string>>();
  const mutations: string[] = [];
  let next = 500;
  const gh: AppEpicPromotionGitHub = {
    ensureLabel: async (label) => {
      if (labels.has(label)) return;
      if (opts.labelCreateFails) throw new Error('HTTP 403: Resource not accessible by integration');
      labels.add(label);
    },
    createIssue: async () => {
      next += 1;
      issueLabels.set(next, new Set());
      mutations.push(`create#${next}`);
      return next;
    },
    addLabel: async (issue, label) => {
      if (!labels.has(label)) throw new Error(`'${label}' not found`);
      issueLabels.get(issue)?.add(label);
      mutations.push(`label#${issue}`);
    },
    appendIssueBody: async (issue) => void mutations.push(`append#${issue}`),
    closePr: async (pr) => void mutations.push(`closePr#${pr}`),
  };
  return { gh, labels, issueLabels, mutations };
}

describe('runEpicPromotion — the sub-ticket labels exist before any issue is created (§28.7)', () => {
  it('creates the missing labels, then promotes the whole chain with every sub-ticket labelled', async () => {
    const github = labelledGitHub({ labels: ['agent-loop/ready'] });
    await runEpicPromotion(github.gh, REQUEST, memStore().store);
    expect([...github.labels]).toEqual(expect.arrayContaining(['agent-loop/subticket', 'agent-loop/ready']));
    for (const n of [501, 502]) {
      expect([...(github.issueLabels.get(n) ?? [])].sort()).toEqual(['agent-loop/ready', 'agent-loop/subticket']);
    }
    expect(github.mutations).toContain('closePr#4242');
  });

  it('when a missing label cannot be created, asks the operator to create it and changes nothing on GitHub', async () => {
    const github = labelledGitHub({ labels: ['agent-loop/ready'], labelCreateFails: true });
    const { store, saved } = memStore();
    const run = runEpicPromotion(github.gh, REQUEST, store);
    await expect(run).rejects.toThrow('gh label create agent-loop/subticket');
    await expect(run).rejects.toThrow(/HTTP 403/);
    expect(github.mutations).toEqual([]);
    expect(saved()).toBeNull();
  });

  it('resumes a promotion stranded by a missing label: labels it, never re-creates it, and finishes the chain', async () => {
    const github = labelledGitHub({ labels: ['agent-loop/ready'] });
    const { store } = memStore({ epic: 176, created: [{ index: 1, issue: 236, title: 'Slice one' }], trackingAppended: false, prClosed: false });
    await runEpicPromotion(github.gh, REQUEST, store);
    expect(github.mutations.filter((m) => m.startsWith('create#'))).toEqual(['create#501']);
    expect(github.mutations).toContain('label#236');
    expect(github.mutations).toContain('closePr#4242');
  });
});
