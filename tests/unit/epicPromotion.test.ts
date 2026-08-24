import { describe, expect, it, vi } from 'vitest';
import { createEpicPromotionCoordinator, type EpicPromotionCoordinatorDeps } from '../../src/main/epicPromotion';
import type { LoopDefV2 } from '../../src/main/loopDefV2';
import type { EpicSubTicket } from '../../src/shared/epicPlan';

// §28.7 — the epic-promotion coordinator: a gate-decision-time confirm-first hold. maybeBegin intercepts an
// approve on an epic plan (raise the preview, hold, do NOT accept); resolve completes it — confirm runs the
// promotion then accepts + stands the flow down, decline drops it and leaves the gate. Mirrors the
// bootstrap-conflict coordinator's held/resolve pattern.

const DEF = {} as LoopDefV2;
const SUBS: EpicSubTicket[] = [
  { index: 1, title: 'Slice one', body: 'Acceptance criteria: a\n\nplan one' },
  { index: 2, title: 'Slice two', body: 'Acceptance criteria: b\n\nplan two' },
];

function harness(over: Partial<EpicPromotionCoordinatorDeps> = {}) {
  const deps: EpicPromotionCoordinatorDeps = {
    readSubTickets: vi.fn(() => SUBS),
    emitPreview: vi.fn(),
    runPromotion: vi.fn(() => Promise.resolve()),
    persistAccept: vi.fn(),
    terminateFlow: vi.fn(),
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
    const intercepted = coord.maybeBegin('/repo', DEF, 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle', { epic: 176, pr: 77 });
    expect(intercepted).toBe(true);
    expect(deps.emitPreview).toHaveBeenCalledWith({
      repoDir: '/repo', step: 'plan-bundle', epic: 176, pr: 77,
      subTickets: [{ index: 1, title: 'Slice one' }, { index: 2, title: 'Slice two' }],
    });
    expect(deps.persistAccept).not.toHaveBeenCalled(); // held pending confirm — nothing accepted yet
  });

  it('does not intercept a non-epic plan (readSubTickets null)', () => {
    const { deps, coord } = harness({ readSubTickets: vi.fn(() => null) });
    expect(coord.maybeBegin('/repo', DEF, 'l', 's', 't', { epic: 176, pr: 77 })).toBe(false);
    expect(deps.emitPreview).not.toHaveBeenCalled();
  });

  it('does not intercept when the epic issue number is unknown (cannot promote)', () => {
    const { deps, coord } = harness();
    expect(coord.maybeBegin('/repo', DEF, 'l', 's', 't', { epic: null, pr: 77 })).toBe(false);
    expect(deps.emitPreview).not.toHaveBeenCalled();
  });
});

describe('resolve — complete the held promotion (§28.7)', () => {
  const begin = (coord: ReturnType<typeof harness>['coord']): boolean =>
    coord.maybeBegin('/repo', DEF, 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle', { epic: 176, pr: 77 });

  it('confirm runs the promotion then persists the accept + stands the flow down', async () => {
    const { deps, coord } = harness();
    begin(coord);
    await coord.resolve('/repo', 'plan-bundle', true);
    expect(deps.runPromotion).toHaveBeenCalledWith('/repo', { epic: 176, pr: 77, subTickets: SUBS });
    expect(deps.persistAccept).toHaveBeenCalledWith('/repo', 'plan-bundle-loop', 'plan-bundle', 'consolidate-plan-bundle');
    expect(deps.terminateFlow).toHaveBeenCalledWith('/repo');
    expect(deps.audit).toHaveBeenCalledWith('/repo', 'epic-promotion', 0);
    expect(deps.onViewChanged).toHaveBeenCalled();
  });

  it('decline drops the promotion and leaves the gate — nothing promoted, nothing accepted', async () => {
    const { deps, coord } = harness();
    begin(coord);
    await coord.resolve('/repo', 'plan-bundle', false);
    expect(deps.runPromotion).not.toHaveBeenCalled();
    expect(deps.persistAccept).not.toHaveBeenCalled();
    expect(deps.audit).toHaveBeenCalledWith('/repo', 'epic-promotion-declined', 0);
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
    expect(deps.audit).not.toHaveBeenCalledWith('/repo', 'epic-promotion', 0);
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
});

// §28.7 slice C — the promotion executor: create each sub-ticket in order (the plan slice VERBATIM + the epic
// link + the REAL preceding issue number), uniform labels, then append the epic's tracking checklist, then
// close the epic planning PR. The gh port is injected so the sequence is asserted with no real gh.
import { runEpicPromotion, type AppEpicPromotionGitHub, type EpicPromotionStore } from '../../src/main/epicPromotion';
import type { EpicPromotionState } from '../../src/main/appLoopState';

function fakeGh() {
  const events: string[] = [];
  let next = 500;
  const gh: AppEpicPromotionGitHub = {
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
    const { gh, events } = fakeGh();
    const partial = memStore({ epic: 176, created: [REC1], trackingAppended: false, prClosed: false });
    await runEpicPromotion(gh, REQUEST, partial.store);
    expect(events.filter((e) => e.startsWith('create#'))).toHaveLength(1); // only #2 is created
    expect(events.find((e) => e.startsWith('create#'))).toContain('Preceding sub-ticket: #501'); // stacks on recorded #501
    expect(events.find((e) => e.startsWith('append #176'))).toContain('- [ ] #501 — Slice one'); // checklist names both
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
});
