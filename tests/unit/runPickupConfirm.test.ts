import { describe, expect, it } from 'vitest';
import {
  awaitingPickupConfirm,
  reachedPickupStep,
  createRunPickupConfirmations,
  proposeRunPickup,
  verifyRunPickup,
  type PickupEvidence,
} from '../../src/main/runPickupConfirm';
import type { PullRequestLookup, PullRequest } from '../../src/main/pullRequestLookup';
import type { AppLoopBootstrap } from '../../src/main/appLoopState';
import type { RunIdentity } from '../../src/main/gateRunState';

// §27.13 v2.211 — a run past its pickup with no saved pickup is held until the operator confirms the ticket and PR
// the app worked out from the branch, GitHub and the flow's ticket input.

const BRANCH = 'plan-loop/issue-218';
const open233: PullRequest = { number: 233, branch: BRANCH, state: 'OPEN', closingIssues: [218] };

function lookup(prs: PullRequest[], opts: { failList?: string; failView?: string } = {}): PullRequestLookup {
  return {
    async openForBranch(branch) {
      if (opts.failList) throw new Error(opts.failList);
      return prs.filter((p) => p.branch === branch && p.state === 'OPEN').map((p) => p.number);
    },
    async pullRequest(n) {
      if (opts.failView) throw new Error(opts.failView);
      const pr = prs.find((p) => p.number === n);
      if (pr === undefined) throw new Error(`no pull request #${n}`);
      return pr;
    },
  };
}

const evidence = (over: Partial<PickupEvidence> = {}): PickupEvidence => ({
  branch: BRANCH,
  flowTicket: 218,
  bootstrapRecord: { kind: 'none' },
  ...over,
});

describe('the proposal the operator is asked to confirm', () => {
  it('names the branch’s one open PR and the flow’s ticket it closes, with nothing to flag', async () => {
    expect(await proposeRunPickup(evidence(), lookup([open233]))).toEqual({ branch: BRANCH, pr: 233, ticket: 218, problems: [] });
  });

  it('takes the ticket from the PR when the flow has none', async () => {
    expect(await proposeRunPickup(evidence({ flowTicket: null }), lookup([open233]))).toMatchObject({ pr: 233, ticket: 218, problems: [] });
  });

  it('flags a PR that does not close the flow’s ticket, and keeps the flow’s ticket', async () => {
    const proposal = await proposeRunPickup(evidence({ flowTicket: 300 }), lookup([open233]));
    expect(proposal).toMatchObject({ pr: 233, ticket: 300 });
    expect(proposal.problems.join('\n')).toMatch(/#233.*#300/);
  });

  it('falls back to the pickup record’s PR when the branch has no open PR, and says so', async () => {
    const record = { kind: 'complete' as const, bootstrap: { pr: 233, branch: BRANCH, issue: 218 } };
    const proposal = await proposeRunPickup(evidence({ bootstrapRecord: record }), lookup([]));
    expect(proposal).toMatchObject({ pr: 233, ticket: 218 });
    expect(proposal.problems.join('\n')).toContain(`no open pull request for ${BRANCH}`);
  });

  it('proposes no PR when the branch has several open ones, and names them', async () => {
    const proposal = await proposeRunPickup(evidence(), lookup([open233, { ...open233, number: 240 }]));
    expect(proposal.pr).toBeNull();
    expect(proposal.problems.join('\n')).toMatch(/#233.*#240/);
  });

  it('flags a pickup record that disagrees with what GitHub says', async () => {
    const record = { kind: 'complete' as const, bootstrap: { pr: 100, branch: 'other', issue: 218 } };
    const proposal = await proposeRunPickup(evidence({ bootstrapRecord: record }), lookup([open233]));
    expect(proposal.pr).toBe(233);
    expect(proposal.problems.join('\n')).toContain('#100');
  });

  it('flags an unreadable pickup record', async () => {
    const proposal = await proposeRunPickup(evidence({ bootstrapRecord: { kind: 'invalid', detail: 'bootstrap.yaml is not valid YAML' } }), lookup([open233]));
    expect(proposal.problems.join('\n')).toContain('bootstrap.yaml is not valid YAML');
    expect(proposal.problems.join('\n')).toMatch(/turns stay stopped until it is repaired/i);
  });

  it('proposes no PR on a detached HEAD, and says why', async () => {
    const proposal = await proposeRunPickup(evidence({ branch: null }), lookup([open233]));
    expect(proposal).toMatchObject({ branch: null, pr: null, ticket: 218 });
    expect(proposal.problems).toHaveLength(1);
  });

  it('reports a GitHub lookup that fails instead of throwing', async () => {
    const proposal = await proposeRunPickup(evidence(), lookup([open233], { failList: 'gh: not logged in' }));
    expect(proposal.pr).toBeNull();
    expect(proposal.problems.join('\n')).toContain('gh: not logged in');
  });
});

describe('verifying what the operator confirms', () => {
  it('accepts an open PR on the checked-out branch that closes the ticket', async () => {
    expect(await verifyRunPickup(lookup([open233]), { branch: BRANCH, pr: 233, ticket: 218 })).toBeNull();
  });

  it.each([
    ['a closed PR', [{ ...open233, state: 'CLOSED' as const }], { pr: 233, ticket: 218 }, /not open/],
    ['a PR on another branch', [{ ...open233, branch: 'other' }], { pr: 233, ticket: 218 }, /other/],
    ['a PR that does not close the ticket', [open233], { pr: 233, ticket: 300 }, /#300/],
    ['a PR GitHub does not know', [open233], { pr: 999, ticket: 218 }, /#999/],
  ])('refuses %s, saying why', async (_name, prs, picked, reason) => {
    expect(await verifyRunPickup(lookup(prs), { branch: BRANCH, ...picked })).toMatch(reason);
  });

  it('refuses on a detached HEAD', async () => {
    expect(await verifyRunPickup(lookup([open233]), { branch: null, pr: 233, ticket: 218 })).toMatch(/branch/);
  });
});

describe('the hold', () => {
  const RUN: RunIdentity = { flow: 'feature-dev-v3', startedAt: 1792407818398 };

  function harness(prs: PullRequest[] = [open233], gh: (prs: PullRequest[]) => PullRequestLookup = lookup) {
    let heldRun: RunIdentity | null = RUN;
    let ev = evidence();
    const trusted: AppLoopBootstrap[] = [];
    let changes = 0;
    const confirmations = createRunPickupConfirmations({
      heldRun: () => (heldRun === null ? null : { run: heldRun, initialStatus: 'planning' }),
      evidence: () => ev,
      lookup: () => gh(prs),
      trust: (_repo, pickup) => {
        trusted.push(pickup);
        heldRun = null;
      },
      changed: () => {
        changes += 1;
      },
    });
    const settled = async (): Promise<void> => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    };
    return {
      confirmations,
      trusted,
      changes: () => changes,
      settled,
      release: () => {
        heldRun = null;
      },
      switchRun: (run: RunIdentity) => {
        heldRun = run;
      },
      setEvidence: (next: PickupEvidence) => {
        ev = next;
      },
    };
  }

  it('shows nothing and holds nothing for a run that needs no confirm', () => {
    const h = harness();
    h.release();
    expect(h.confirmations.view('/repo')).toBeUndefined();
    expect(h.confirmations.held('/repo')).toBe(false);
  });

  it('holds the run, looks up the proposal, then shows it and announces the change', async () => {
    const h = harness();
    expect(h.confirmations.held('/repo')).toBe(true);
    expect(h.confirmations.view('/repo')).toEqual({ run: RUN, state: 'looking' });
    await h.settled();
    expect(h.changes()).toBeGreaterThan(0);
    expect(h.confirmations.view('/repo')).toEqual({ run: RUN, state: 'proposed', branch: BRANCH, pr: 233, ticket: 218, problems: [] });
  });

  it('a verified confirm saves the pickup for the run and releases the hold', async () => {
    const h = harness();
    const result = await h.confirmations.confirm('/repo', RUN, 233, 218);
    expect(result).toEqual({ ok: true });
    expect(h.trusted).toEqual([{ pr: 233, branch: BRANCH, issue: 218, initialStatus: 'planning' }]);
    expect(h.confirmations.held('/repo')).toBe(false);
    expect(h.confirmations.view('/repo')).toBeUndefined();
  });

  it('a confirm GitHub does not back is refused with the reason, and the run stays held', async () => {
    const h = harness([{ ...open233, closingIssues: [999] }]);
    const result = await h.confirmations.confirm('/repo', RUN, 233, 218);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('does not close ticket #218');
    expect(h.trusted).toEqual([]);
    expect(h.confirmations.held('/repo')).toBe(true);
  });

  it('a confirm naming a run other than the held one is refused', async () => {
    const h = harness();
    h.switchRun({ ...RUN, startedAt: RUN.startedAt + 1 });
    const result = await h.confirmations.confirm('/repo', RUN, 233, 218);
    expect(result.ok).toBe(false);
    expect(h.trusted).toEqual([]);
  });

  it('a confirm with nothing held is refused', async () => {
    const h = harness();
    h.release();
    expect((await h.confirmations.confirm('/repo', RUN, 233, 218)).ok).toBe(false);
    expect(h.trusted).toEqual([]);
  });

  it('a confirm checks the branch checked out at the confirm, not the one the proposal was made for', async () => {
    const h = harness();
    h.confirmations.view('/repo');
    await h.settled();
    h.setEvidence(evidence({ branch: 'moved-on' }));
    expect((await h.confirmations.confirm('/repo', RUN, 233, 218)).ok).toBe(false);
    expect(h.trusted).toEqual([]);
  });

  it('a confirm naming a ticket other than the flow’s own is refused, naming the flow’s ticket', async () => {
    const h = harness([{ ...open233, closingIssues: [218, 300] }]);
    const result = await h.confirmations.confirm('/repo', RUN, 233, 300);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('#218');
    expect(h.trusted).toEqual([]);
  });

  function slowGitHub() {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gh = (prs: PullRequest[]): PullRequestLookup => {
      const fast = lookup(prs);
      return { openForBranch: fast.openForBranch, pullRequest: async (n) => {
        await gate;
        return fast.pullRequest(n);
      } };
    };
    return { gh, release: () => release() };
  }

  it('a confirm whose run is replaced while GitHub is being asked is refused, and saves nothing', async () => {
    const slow = slowGitHub();
    const h = harness([open233], slow.gh);
    const pending = h.confirmations.confirm('/repo', RUN, 233, 218);
    h.switchRun({ ...RUN, startedAt: RUN.startedAt + 1 });
    slow.release();
    expect((await pending).ok).toBe(false);
    expect(h.trusted).toEqual([]);
  });

  it('a confirm whose run stops waiting while GitHub is being asked is refused, and saves nothing', async () => {
    const slow = slowGitHub();
    const h = harness([open233], slow.gh);
    const pending = h.confirmations.confirm('/repo', RUN, 233, 218);
    h.release();
    slow.release();
    expect((await pending).ok).toBe(false);
    expect(h.trusted).toEqual([]);
  });

  it('a new run held after the first is looked up afresh', async () => {
    const h = harness();
    h.confirmations.view('/repo');
    await h.settled();
    const next = { ...RUN, startedAt: RUN.startedAt + 1 };
    h.switchRun(next);
    expect(h.confirmations.view('/repo')).toEqual({ run: next, state: 'looking' });
  });
});

describe('which runs wait for a confirm', () => {
  const RUN: RunIdentity = { flow: 'feature-dev-v3', startedAt: 1792407818398 };
  const complete = (pr: number, issue: number) => ({ kind: 'complete' as const, bootstrap: { pr, branch: 'plan-loop/issue-176', issue } });
  const facts = (over: Partial<Parameters<typeof awaitingPickupConfirm>[0]> = {}): Parameters<typeof awaitingPickupConfirm>[0] => ({
    run: RUN,
    pickupInFlight: false,
    pickupStep: 'behind',
    runBegunHere: false,
    flowRefs: { ticket: 176, pr: null },
    bootstrapRecord: { kind: 'none' },
    ...over,
  });

  it('a run resumed past its pickup with no saved pickup waits, whatever the pickup record says', () => {
    for (const bootstrapRecord of [{ kind: 'none' as const }, { kind: 'pending' as const }, complete(4242, 176), { kind: 'invalid' as const, detail: 'x' }]) {
      expect(awaitingPickupConfirm(facts({ bootstrapRecord }))).toEqual(RUN);
    }
  });

  it.each([
    ['no run is in progress', { run: null }],
    ['a pickup is running now', { pickupInFlight: true }],
    ['the run has not reached a pickup step', { pickupStep: 'none' as const }],
    ['this app started the run, so it saw its pickup or the lack of one', { runBegunHere: true }],
    ['this app started the run, at its pickup step', { runBegunHere: true, pickupStep: 'current' as const, bootstrapRecord: complete(4242, 176) }],
    ['the flow’s own inputs name both the ticket and the PR, with no pickup record', { flowRefs: { ticket: 176, pr: 77 } }],
    ['the flow’s own inputs name the ticket and PR the pickup record names', { flowRefs: { ticket: 176, pr: 4242 }, bootstrapRecord: complete(4242, 176) }],
  ])('nothing waits when %s', (_name, over) => {
    expect(awaitingPickupConfirm(facts(over))).toBeNull();
  });

  it('a run whose flow inputs name a PR the pickup record contradicts still waits', () => {
    expect(awaitingPickupConfirm(facts({ flowRefs: { ticket: 176, pr: 77 }, bootstrapRecord: complete(4242, 176) }))).toEqual(RUN);
    expect(awaitingPickupConfirm(facts({ flowRefs: { ticket: 176, pr: 77 }, bootstrapRecord: { kind: 'pending' } }))).toEqual(RUN);
    expect(awaitingPickupConfirm(facts({ flowRefs: { ticket: 176, pr: 4242 }, bootstrapRecord: complete(4242, 999) }))).toEqual(RUN);
  });

  it('at the pickup step, a resumed run waits only on evidence that its own pickup began', () => {
    const current = (bootstrapRecord: Parameters<typeof awaitingPickupConfirm>[0]['bootstrapRecord'], ticket: number | null = 176) =>
      awaitingPickupConfirm(facts({ pickupStep: 'current', bootstrapRecord, flowRefs: { ticket, pr: null } }));
    expect(current({ kind: 'pending' })).toEqual(RUN);
    expect(current(complete(4242, 176))).toEqual(RUN);
    expect(current({ kind: 'none' })).toBeNull();
    expect(current(complete(100, 90))).toBeNull();
    expect(current(complete(100, 90), null)).toBeNull();
    expect(current({ kind: 'invalid', detail: 'unreadable' })).toBeNull();
  });
});

describe('the pickup step a run has reached', () => {
  type Step = { id: string; pickup?: string };
  const steps: Step[] = [{ id: 'groom' }, { id: 'plan', pickup: 'planning' }, { id: 'impl', pickup: 'implementing' }, { id: 'done' }];
  const contractOf = (s: Step) => (s.pickup === undefined ? null : s.pickup);

  it('is none before the first step that runs a pickup', () => {
    expect(reachedPickupStep(steps, 1, contractOf)).toBeNull();
  });

  it('is current while the run is on that step', () => {
    expect(reachedPickupStep(steps, 2, contractOf)).toEqual({ contract: 'planning', at: 'current' });
  });

  it('is behind once the run has moved past it, and is always the first such step', () => {
    expect(reachedPickupStep(steps, 3, contractOf)).toEqual({ contract: 'planning', at: 'behind' });
    expect(reachedPickupStep(steps, 4, contractOf)).toEqual({ contract: 'planning', at: 'behind' });
  });
});
