import { describe, expect, it } from 'vitest';
import { parseAdoptedPickup, serializeAdoptedPickup, type AdoptedPickup } from '../../src/shared/appBootstrap';
import { jobMatchesFlowRefs, trustedPickupServesJob, type AppLoopBootstrapJob } from '../../src/main/appLoopBootstrap';
import { awaitingPickupConfirm, proposeRunPickup } from '../../src/main/runPickupConfirm';
import type { PullRequestLookup } from '../../src/main/pullRequestLookup';

// #304 — the adopted pickup's one validator, the job's input identity, and how a ticket run treats a record an
// adopting run wrote.

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const ADOPTED: AdoptedPickup = {
  kind: 'adopted',
  pr: 41,
  host: 'github.com',
  fixBranch: 'agent-terminal/review-pr-41-1700000000000',
  startedAt: 1_700_000_000_000,
  headRef: 'feature/reviewed-change',
  baseRef: 'main',
  headRepo: 'owner/repo',
  crossRepository: false,
  tickets: [{ repo: 'owner/repo', number: 176 }],
  primary: { repo: 'owner/repo', number: 176 },
  headOid: HEAD,
  baseOid: BASE,
};

describe('parseAdoptedPickup — the one validator both pickup files read through', () => {
  it('reads back what serializeAdoptedPickup wrote', () => {
    expect(parseAdoptedPickup(serializeAdoptedPickup(ADOPTED))).toEqual({ ok: true, pickup: ADOPTED });
  });

  it.each([
    ['a primary outside its tickets', { primary: { repo: 'owner/repo', number: 177 } }],
    ['a base_oid that is not an object id', { base_oid: 'not-an-object-id' }],
    ['a head_repo that is not <owner>/<name>', { head_repo: 'owner' }],
    ['a cross_repository that is not a boolean', { cross_repository: 'no' }],
    ['a fix_branch its run does not derive', { fix_branch: 'agent-terminal/review-pr-41-1' }],
    ['a head_ref the branch rule refuses', { head_ref: 'feature/a+b' }],
    ['a base_ref the branch rule refuses', { base_ref: 'base+name' }],
    ["a host that is not origin's lowercased host", { host: 'GitHub.com' }],
    ['no host', { host: undefined }],
    ['a host that is not one host part', { host: 'ghe.example.com/x' }],
    ['an empty host', { host: '' }],
    ['a ticket other than its primary that is not {repo, number}', { tickets: [{ repo: 'owner/repo', number: 0 }, { repo: 'owner/repo', number: 176 }] }],
  ])('refuses %s', (_case, change) => {
    expect(parseAdoptedPickup({ ...serializeAdoptedPickup(ADOPTED), ...change }).ok).toBe(false);
  });
});

const job = (bootstrap: AppLoopBootstrapJob['bootstrap'], issue: number | null = null): AppLoopBootstrapJob => ({
  repoDir: '/repo',
  loopName: 'review-loop',
  stepId: 'review',
  entryToken: 1,
  issue,
  entry: 'fresh-run',
  bootstrap,
});
const TICKET_FORM = { initialStatus: 'planning', branchTemplate: 'plan-loop/issue-{issue}', initialLabels: [], wipe: { mode: 'abort' as const } };

describe('jobMatchesFlowRefs — a job is current only while the flow still names the input it was entered with', () => {
  it('an adopting job matches the flow while it names the same PR, and not once it names another or none', () => {
    expect(jobMatchesFlowRefs(job({ adopt: 'pr', pr: 41 }), { pr: 41 })).toBe(true);
    expect(jobMatchesFlowRefs(job({ adopt: 'pr', pr: 41 }), { pr: 42 })).toBe(false);
    expect(jobMatchesFlowRefs(job({ adopt: 'pr', pr: 41 }), {})).toBe(false);
  });

  it("a ticket-form job follows the flow's ticket, whatever its PR", () => {
    expect(jobMatchesFlowRefs(job(TICKET_FORM, 176), { ticket: 176, pr: 9 })).toBe(true);
    expect(jobMatchesFlowRefs(job(TICKET_FORM, 176), { ticket: 177 })).toBe(false);
  });
});

describe('trustedPickupServesJob — a job re-enters on the pickup its run trusts only when that pickup is its own', () => {
  const OPENED = { pr: 9, branch: 'plan-loop/issue-176', issue: 176, initialStatus: 'planning' };
  it('serves an adopt job from an adopted pickup for the same PR, and no other', () => {
    expect(trustedPickupServesJob(job({ adopt: 'pr', pr: 41 }), ADOPTED)).toBe(true);
    expect(trustedPickupServesJob(job({ adopt: 'pr', pr: 42 }), ADOPTED)).toBe(false);
    expect(trustedPickupServesJob(job({ adopt: 'pr', pr: 41 }), { ...OPENED, pr: 41 })).toBe(false);
    expect(trustedPickupServesJob(job({ adopt: 'pr', pr: 41 }), undefined)).toBe(false);
  });

  it("serves a ticket job from its own ticket's opened pickup, never from an adopted one", () => {
    expect(trustedPickupServesJob(job(TICKET_FORM, 176), OPENED)).toBe(true);
    expect(trustedPickupServesJob(job(TICKET_FORM, 177), OPENED)).toBe(false);
    expect(trustedPickupServesJob(job(TICKET_FORM, 176), ADOPTED)).toBe(false);
  });
});

describe("a ticket run never takes an adopting run's pickup record as its own", () => {
  const RUN = { flow: 'feature-dev-v3', startedAt: 1_792_407_818_398 };
  const adoptedRecord = { kind: 'complete' as const, bootstrap: ADOPTED };

  it("keeps a resumed ticket run held even when an adopted record names the flow's PR", () => {
    expect(
      awaitingPickupConfirm({ run: RUN, pickupInFlight: false, pickupStep: 'behind', runBegunHere: false, flowRefs: { ticket: 176, pr: 41 }, bootstrapRecord: adoptedRecord }),
    ).toEqual(RUN);
  });

  it('proposes nothing from the adopted record, and names the PR that run adopted', async () => {
    const none: PullRequestLookup = { openForBranch: async () => [], pullRequest: async (n) => { throw new Error(`no pull request #${n}`); } };
    const proposal = await proposeRunPickup({ branch: ADOPTED.fixBranch, flowTicket: null, bootstrapRecord: adoptedRecord }, none);
    expect.soft(proposal.pr).toBeNull();
    expect.soft(proposal.ticket).toBeNull();
    expect.soft(proposal.problems.join('\n')).toMatch(/#41\b/);
    expect.soft(proposal.problems.join('\n')).not.toMatch(/undefined/);
  });
});
