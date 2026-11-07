import { describe, expect, it, vi } from 'vitest';
import { awaitingPickupConfirm, createRunPickupConfirmations, proposeRunPickup, type PickupEvidence } from '../../src/main/runPickupConfirm';
import type { PullRequest, PullRequestLookup } from '../../src/main/pullRequestLookup';
import type { RunIdentity } from '../../src/main/gateRunState';
import { adoptedFixBranch, type AdoptedPickup } from '../../src/shared/appBootstrap';

// #304 AC 24 — a relaunched adopting run with no saved pickup, whose start record still names its PR, is held until
// the operator confirms the reviewed PR and the recorded primary ticket; the confirm re-checks GitHub and the checkout.

const RUN: RunIdentity = { flow: 'adopt-pr-fixture', startedAt: 1_700_000_000_000 };
const FIX_BRANCH = adoptedFixBranch(41, RUN.startedAt);
// The primary is the fork's ticket, so a proposal or confirm that falls back to origin's ticket is told apart.
const ADOPTED: AdoptedPickup = {
  kind: 'adopted',
  pr: 41,
  host: 'github.com',
  fixBranch: FIX_BRANCH,
  startedAt: RUN.startedAt,
  headRef: 'feature/reviewed-change',
  baseRef: 'main',
  headRepo: 'contributor/fork',
  crossRepository: true,
  tickets: [
    { repo: 'owner/repo', number: 176 },
    { repo: 'contributor/fork', number: 177 },
  ],
  primary: { repo: 'contributor/fork', number: 177 },
  headOid: 'a'.repeat(40),
  baseOid: 'b'.repeat(40),
};
const REVIEWED: PullRequest = {
  number: 41,
  branch: 'feature/reviewed-change',
  state: 'OPEN',
  closingIssues: [176, 177],
  closingTickets: [
    { repo: 'owner/repo', number: 176 },
    { repo: 'contributor/fork', number: 177 },
  ],
  crossRepository: true,
};

function lookup(prs: PullRequest[]): PullRequestLookup {
  return {
    async openForBranch(branch) {
      return prs.filter((p) => p.branch === branch && p.state === 'OPEN' && !p.crossRepository).map((p) => p.number);
    },
    async pullRequest(n) {
      const pr = prs.find((p) => p.number === n);
      if (pr === undefined) throw new Error(`no pull request #${n}`);
      return pr;
    },
  };
}

const evidence = (over: Partial<PickupEvidence> = {}): PickupEvidence => ({
  branch: FIX_BRANCH,
  flowTicket: null,
  bootstrapRecord: { kind: 'complete', bootstrap: ADOPTED },
  adopting: { pr: 41, startedAt: RUN.startedAt },
  ...over,
});

describe('which adopting runs wait for a confirm', () => {
  it('a run resumed at its adopting step, with no saved pickup and a start record naming its PR, waits', () => {
    const facts = { run: RUN, pickupInFlight: false, runBegunHere: false, flowRefs: { ticket: null, pr: 41 }, bootstrapRecord: { kind: 'complete' as const, bootstrap: ADOPTED }, adopting: true as const };
    expect.soft(awaitingPickupConfirm({ ...facts, pickupStep: 'current' })).toEqual(RUN);
    expect.soft(awaitingPickupConfirm({ ...facts, pickupStep: 'behind' })).toEqual(RUN);
  });
});

describe('the proposal for an adopting run', () => {
  it('names the reviewed PR and the recorded primary ticket, with its repository, with nothing to flag', async () => {
    const proposal = await proposeRunPickup(evidence(), lookup([REVIEWED]));
    expect.soft(proposal).toMatchObject({ pr: 41 });
    expect.soft(JSON.stringify(proposal)).toContain('contributor/fork');
    expect.soft(JSON.stringify(proposal)).toMatch(/\b177\b/);
    expect.soft(proposal.problems).toEqual([]);
  });

  it('flags a checked-out branch other than the fix branch, naming both', async () => {
    const proposal = await proposeRunPickup(evidence({ branch: 'elsewhere' }), lookup([REVIEWED]));
    expect.soft(proposal).toMatchObject({ pr: 41 });
    expect.soft(proposal.problems.join('\n')).toContain(FIX_BRANCH);
    expect.soft(proposal.problems.join('\n')).toContain('elsewhere');
  });

  it('flags a reviewed PR that is no longer open', async () => {
    const proposal = await proposeRunPickup(evidence(), lookup([{ ...REVIEWED, state: 'CLOSED' }]));
    expect.soft(proposal).toMatchObject({ pr: 41 });
    expect.soft(proposal.problems.join('\n')).toMatch(/#41/);
    expect.soft(proposal.problems.join('\n')).toMatch(/Pull request #41 is closed\./);
  });
});

describe("the confirm of an adopting run's pickup", () => {
  function harness(prs: PullRequest[], ev: PickupEvidence = evidence()) {
    let held = true;
    const trusted: unknown[] = [];
    const confirmations = createRunPickupConfirmations({
      heldRun: () => (held ? { run: RUN, initialStatus: 'reviewing' } : null),
      evidence: () => ev,
      lookup: () => lookup(prs),
      trust: (_repo, pickup) => {
        trusted.push(pickup);
        held = false;
      },
      changed: () => {},
    });
    return { confirmations, trusted };
  }

  it("saves the start record's adopted pickup for the run when the operator confirms the PR and the primary", async () => {
    const h = harness([REVIEWED]);
    expect.soft(await h.confirmations.confirm('/repo', RUN, 41, 177)).toEqual({ ok: true });
    expect.soft(h.trusted).toEqual([ADOPTED]);
    expect.soft(h.confirmations.held('/repo')).toBe(false);
  });

  it.each([
    ['a ticket that is not the recorded primary', [REVIEWED], evidence(), 176, /177/],
    ['a reviewed PR that is closed', [{ ...REVIEWED, state: 'CLOSED' as const }], evidence(), 177, /Pull request #41 is closed\./],
    ['a reviewed PR that no longer closes the primary', [{ ...REVIEWED, closingIssues: [176], closingTickets: [{ repo: 'owner/repo', number: 176 }] }], evidence(), 177, /177/],
    ['a checkout of a branch other than the fix branch', [REVIEWED], evidence({ branch: 'elsewhere' }), 177, new RegExp(FIX_BRANCH)],
    [
      'a start record that names another PR, saying the run must be terminated and started again',
      [REVIEWED, { ...REVIEWED, number: 42 }],
      evidence({ bootstrapRecord: { kind: 'complete', bootstrap: { ...ADOPTED, pr: 42, fixBranch: adoptedFixBranch(42, RUN.startedAt) } } }),
      177,
      /terminat/i,
    ],
    ['a run whose start record is missing too, saying the run must be terminated and started again', [REVIEWED], evidence({ bootstrapRecord: { kind: 'none' } }), 177, /terminat/i],
    [
      "an earlier run's start record on the same PR, saying the run must be terminated and started again (AC 13)",
      [REVIEWED],
      evidence({ bootstrapRecord: { kind: 'complete', bootstrap: { ...ADOPTED, startedAt: RUN.startedAt - 1, fixBranch: adoptedFixBranch(41, RUN.startedAt - 1) } }, branch: adoptedFixBranch(41, RUN.startedAt - 1) }),
      177,
      /terminat/i,
    ],
  ])('refuses %s, saying why, and saves nothing', async (_name, prs, ev, ticket, reason) => {
    const h = harness(prs, ev);
    const result = await h.confirmations.confirm('/repo', RUN, 41, ticket);
    expect.soft(result.ok).toBe(false);
    expect.soft(result.ok ? '' : result.reason).toMatch(reason);
    expect.soft(h.trusted).toEqual([]);
    expect.soft(h.confirmations.held('/repo')).toBe(true);
  });
});

describe('a confirm naming a PR other than the one the run adopted', () => {
  it('is refused, naming the recorded PR, and saves nothing', async () => {
    const trusted: unknown[] = [];
    const confirmations = createRunPickupConfirmations({
      heldRun: () => ({ run: RUN, initialStatus: null }),
      evidence: () => evidence(),
      lookup: () => lookup([REVIEWED, { ...REVIEWED, number: 42 }]),
      trust: (_repo, pickup) => void trusted.push(pickup),
      changed: () => {},
    });
    const result = await confirmations.confirm('/repo', RUN, 42, 177);
    expect.soft(result.ok).toBe(false);
    expect.soft(result.ok ? '' : result.reason).toMatch(/#41\b/);
    expect.soft(trusted).toEqual([]);
    expect.soft(confirmations.held('/repo')).toBe(true);
  });
});

describe('an adopting run whose GitHub lookup fails', () => {
  const failing: PullRequestLookup = {
    openForBranch: async () => [],
    pullRequest: async () => {
      throw new Error('gh: not logged in');
    },
  };

  it('proposes with the failure as a problem instead of rejecting', async () => {
    const proposal = await proposeRunPickup(evidence(), failing);
    expect.soft(proposal).toMatchObject({ pr: 41 });
    expect.soft(proposal.problems.join('\n')).toContain('gh: not logged in');
  });

  it('refuses the confirm with the failure, and saves nothing', async () => {
    const trusted: unknown[] = [];
    const confirmations = createRunPickupConfirmations({
      heldRun: () => ({ run: RUN, initialStatus: null }),
      evidence: () => evidence(),
      lookup: () => failing,
      trust: (_repo, pickup) => void trusted.push(pickup),
      changed: () => {},
    });
    const result = await confirmations.confirm('/repo', RUN, 41, 177);
    expect.soft(result.ok).toBe(false);
    expect.soft(result.ok ? '' : result.reason).toContain('gh: not logged in');
    expect.soft(trusted).toEqual([]);
  });
});

describe("an adopting run's published proposal", () => {
  it('is unchanged for later reads when a caller changes a view it was given', async () => {
    const confirmations = createRunPickupConfirmations({
      heldRun: () => ({ run: RUN, initialStatus: null }),
      evidence: () => evidence({ branch: 'elsewhere' }),
      lookup: () => lookup([REVIEWED]),
      trust: () => {},
      changed: () => {},
    });
    confirmations.view('/repo');
    await vi.waitFor(() => expect(confirmations.view('/repo')?.state).toBe('proposed'));
    const first = confirmations.view('/repo');
    const problems = first?.state === 'proposed' ? [...first.problems] : [];
    if (first?.state === 'proposed') {
      first.problems.push('injected');
      if (first.adopted?.recoverable) first.adopted.primary.number = 999;
    }
    const again = confirmations.view('/repo');
    expect.soft(again?.state === 'proposed' ? again.problems : null).toEqual(problems);
    expect.soft(again?.state === 'proposed' && again.adopted?.recoverable ? again.adopted.primary : null).toEqual({ repo: 'contributor/fork', number: 177 });
  });
});
