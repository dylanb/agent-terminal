import { describe, expect, it } from 'vitest';
import {
  awaitingPickupConfirm,
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
  record: { kind: 'none' },
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
    const proposal = await proposeRunPickup(evidence({ record }), lookup([]));
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
    const proposal = await proposeRunPickup(evidence({ record }), lookup([open233]));
    expect(proposal.pr).toBe(233);
    expect(proposal.problems.join('\n')).toContain('#100');
  });

  it('flags an unreadable pickup record', async () => {
    const proposal = await proposeRunPickup(evidence({ record: { kind: 'invalid', detail: 'bootstrap.yaml is not valid YAML' } }), lookup([open233]));
    expect(proposal.problems.join('\n')).toContain('bootstrap.yaml is not valid YAML');
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

  function harness(prs: PullRequest[] = [open233]) {
    let heldRun: RunIdentity | null = RUN;
    let ev = evidence();
    const trusted: AppLoopBootstrap[] = [];
    let changes = 0;
    const confirmations = createRunPickupConfirmations({
      heldRun: () => heldRun,
      evidence: () => ev,
      lookup: () => lookup(prs),
      initialStatus: () => 'planning',
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
    const h = harness();
    const result = await h.confirmations.confirm('/repo', RUN, 233, 300);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('#300');
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
  const facts = (over: Partial<Parameters<typeof awaitingPickupConfirm>[0]> = {}): Parameters<typeof awaitingPickupConfirm>[0] => ({
    run: RUN,
    pickupInFlight: false,
    pickupStep: 'behind',
    runBegunHere: false,
    flowNamesTicketAndPr: false,
    record: 'none',
    ...over,
  });

  it('a run resumed past its pickup with no saved pickup waits, whatever the pickup record says', () => {
    for (const record of ['none', 'pending', 'complete', 'invalid'] as const) {
      expect(awaitingPickupConfirm(facts({ record }))).toEqual(RUN);
    }
  });

  it.each([
    ['no run is in progress', { run: null }],
    ['a pickup is running now', { pickupInFlight: true }],
    ['the run has not reached a pickup step', { pickupStep: 'none' as const }],
    ['this app started the run, so it saw its pickup or the lack of one', { runBegunHere: true }],
    ['this app started the run, at its pickup step', { runBegunHere: true, pickupStep: 'current' as const, record: 'complete' as const }],
    ['the flow’s own inputs name both the ticket and the PR', { flowNamesTicketAndPr: true }],
  ])('nothing waits when %s', (_name, over) => {
    expect(awaitingPickupConfirm(facts(over))).toBeNull();
  });

  it('at the pickup step, a resumed run waits only when a pickup record exists', () => {
    expect(awaitingPickupConfirm(facts({ pickupStep: 'current', record: 'none' }))).toBeNull();
    expect(awaitingPickupConfirm(facts({ pickupStep: 'current', record: 'pending' }))).toEqual(RUN);
    expect(awaitingPickupConfirm(facts({ pickupStep: 'current', record: 'complete' }))).toEqual(RUN);
    expect(awaitingPickupConfirm(facts({ pickupStep: 'current', record: 'invalid' }))).toEqual(RUN);
  });
});
