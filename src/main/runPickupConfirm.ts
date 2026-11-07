// §27.13 — a run past its pickup that has no saved pickup is held until the operator confirms the ticket and
// pull request the app works out from the checked-out branch, GitHub and the flow's own ticket input.

import { errMsg } from './errno';
import { sameRun, type RunIdentity } from './gateRunState';
import { pickupMismatch, type PullRequestLookup } from './pullRequestLookup';
import { runPickupRel, type RunPickup } from './trustedPickups';
import type { PickupRecord, ReadAppLoopBootstrap } from './appLoopState';
import { isAdoptedPickup, sameTicketRef, type AdoptedPickup } from '../shared/appBootstrap';
import type { AdoptedPickupConfirm, ConfirmRunPickupResult, PickupConfirmView } from '../shared/ipc';

export const PICKUP_CONFIRM_FIRST =
  'Confirm the run’s ticket and pull request first: the app has no saved pull request for this run, so nothing in it continues until you do.';

export type ReachedPickupStep<C> = { contract: C; at: 'behind' | 'current' } | null;

/** The first step up to the 1-based `position` whose loop runs a pickup. */
export function reachedPickupStep<S, C>(steps: readonly S[], position: number, contractOf: (step: S) => C | null): ReachedPickupStep<C> {
  const reached = steps.slice(0, position);
  for (const [i, step] of reached.entries()) {
    const contract = contractOf(step);
    if (contract !== null) return { contract, at: i === reached.length - 1 ? 'current' : 'behind' };
  }
  return null;
}

export const RESTART_KEEPS_PICKUP = `Not restarted: the run’s saved pull request could not be removed, and the restarted run would trust it again. Remove ${runPickupRel()} and Restart, or Terminate and Start.`;

export interface PickupHoldFacts {
  run: RunIdentity | null;
  pickupInFlight: boolean;
  pickupStep: 'none' | 'behind' | 'current';
  /** This app started or restarted the run, so nothing about its pickup was lost to a relaunch. */
  runBegunHere: boolean;
  flowRefs: { ticket: number | null; pr: number | null };
  bootstrapRecord: PickupRecord;
  /** The pickup step adopts the flow's PR. Its pickup is never re-run, and only the start's record can
   *  recover its facts, so a run past it with no saved pickup always waits. */
  adopting?: true;
}

export function awaitingPickupConfirm(f: PickupHoldFacts): RunIdentity | null {
  if (f.run === null || f.pickupInFlight || f.pickupStep === 'none' || f.runBegunHere) return null;
  if (f.adopting) return f.run;
  const record = f.bootstrapRecord;
  const opened = openedPickupOf(record);
  const { ticket, pr } = f.flowRefs;
  const recordAgrees = record.kind === 'none' || (opened !== null && opened.pr === pr && opened.issue === ticket);
  if (ticket !== null && pr !== null && recordAgrees) return null;
  if (f.pickupStep === 'behind') return f.run;
  if (record.kind === 'pending') return f.run;
  return opened !== null && ticket !== null && opened.issue === ticket ? f.run : null;
}

/** The ticket run's pickup a record holds; an adopted PR's record is never one. */
function openedPickupOf(record: PickupRecord): ReadAppLoopBootstrap | null {
  return record.kind === 'complete' && !isAdoptedPickup(record.bootstrap) ? record.bootstrap : null;
}

export interface PickupEvidence {
  branch: string | null;
  flowTicket: number | null;
  bootstrapRecord: PickupRecord;
  /** Present when the run's pickup step adopts a PR: the flow's PR ref and the held run's start. */
  adopting?: { pr: number | null; startedAt: number | null };
}

export interface PickupProposal {
  branch: string | null;
  pr: number | null;
  ticket: number | null;
  problems: string[];
  adopted?: AdoptedPickupConfirm;
}

const unrecoverable = (pr: number | null): string =>
  `This run's primary ticket cannot be recovered: neither its saved pickup nor its start record names ${pr === null ? 'its pull request' : `pull request #${pr}`}. Terminate the run and start it again.`;

/** The start's record of an adopting run, when it names the flow's PR and was written by this run. */
function adoptedRecordOf(evidence: PickupEvidence & { adopting: { pr: number | null; startedAt: number | null } }): AdoptedPickup | null {
  const record = evidence.bootstrapRecord;
  return record.kind === 'complete' &&
    isAdoptedPickup(record.bootstrap) &&
    record.bootstrap.pr === evidence.adopting.pr &&
    record.bootstrap.startedAt === evidence.adopting.startedAt
    ? record.bootstrap
    : null;
}

/** Why the checkout or GitHub no longer backs an adopting run's recorded pickup, or null when they do. */
async function adoptedPickupProblem(record: AdoptedPickup, branch: string | null, lookup: PullRequestLookup): Promise<string | null> {
  if (branch !== record.fixBranch) {
    return `The run's fix branch ${record.fixBranch} is not checked out${branch === null ? '' : `; ${branch} is`}. Check out ${record.fixBranch} and confirm again.`;
  }
  const primary = `${record.primary.repo}#${record.primary.number}`;
  try {
    const pr = await lookup.pullRequest(record.pr);
    if (pr.state !== 'OPEN') return `Pull request #${record.pr} is ${pr.state.toLowerCase()}, not open.`;
    if (!(pr.closingTickets ?? []).some((t) => sameTicketRef(t, record.primary))) return `Pull request #${record.pr} no longer closes ${primary}.`;
  } catch (e) {
    return `GitHub could not confirm pull request #${record.pr}: ${errMsg(e)}`;
  }
  return null;
}

async function proposeAdoptedPickup(evidence: PickupEvidence & { adopting: { pr: number | null; startedAt: number | null } }, lookup: PullRequestLookup): Promise<PickupProposal> {
  const record = adoptedRecordOf(evidence);
  const { branch } = evidence;
  if (record === null) {
    const reason = unrecoverable(evidence.adopting.pr);
    return { branch, pr: evidence.adopting.pr, ticket: null, problems: [reason], adopted: { recoverable: false, reason } };
  }
  const problem = await adoptedPickupProblem(record, branch, lookup);
  return {
    branch,
    pr: record.pr,
    ticket: record.primary.number,
    problems: problem === null ? [] : [problem],
    adopted: { recoverable: true, primary: { ...record.primary } },
  };
}

/** The adopting run's recorded pickup, once the operator's numbers and GitHub back it; or why not. */
async function verifyAdoptedPickup(
  evidence: PickupEvidence & { adopting: { pr: number | null; startedAt: number | null } },
  lookup: PullRequestLookup,
  pr: number,
  ticket: number,
): Promise<{ ok: true; pickup: AdoptedPickup } | { ok: false; reason: string }> {
  const record = adoptedRecordOf(evidence);
  if (record === null) return { ok: false, reason: unrecoverable(evidence.adopting.pr) };
  if (pr !== record.pr) return { ok: false, reason: `This run reviews pull request #${record.pr}; Terminate the run and Start it again to review a different one.` };
  if (ticket !== record.primary.number) {
    return { ok: false, reason: `This run's primary ticket is ${record.primary.repo}#${record.primary.number}; Terminate the run and Start it again to work on a different ticket.` };
  }
  const problem = await adoptedPickupProblem(record, evidence.branch, lookup);
  return problem === null ? { ok: true, pickup: record } : { ok: false, reason: problem };
}

const isAdopting = (evidence: PickupEvidence): evidence is PickupEvidence & { adopting: { pr: number | null; startedAt: number | null } } => evidence.adopting !== undefined;

export async function proposeRunPickup(evidence: PickupEvidence, lookup: PullRequestLookup): Promise<PickupProposal> {
  if (isAdopting(evidence)) return proposeAdoptedPickup(evidence, lookup);
  const problems: string[] = [];
  const record = evidence.bootstrapRecord;
  const recorded = openedPickupOf(record);
  if (record.kind === 'complete' && isAdoptedPickup(record.bootstrap)) {
    problems.push(`The pickup record is the one a run adopting pull request #${record.bootstrap.pr} wrote, not this ticket run's.`);
  }
  if (record.kind === 'invalid') problems.push(`The pickup record could not be used: ${record.detail}. Its turns stay stopped until it is repaired, even after you confirm.`);
  const { branch } = evidence;
  let pr: number | null = null;
  let closing: number[] | null = null;
  if (branch === null) {
    problems.push('No branch is checked out, so the app cannot look up its pull request.');
  } else {
    try {
      const open = await lookup.openForBranch(branch);
      if (open.length === 1) {
        pr = open[0];
        closing = (await lookup.pullRequest(pr)).closingIssues;
      } else if (open.length === 0) {
        problems.push(`GitHub has no open pull request for ${branch}.`);
        if (recorded !== null && recorded.branch === branch) pr = recorded.pr;
      } else {
        problems.push(`GitHub has ${open.length} open pull requests for ${branch}: ${open.map((n) => `#${n}`).join(', ')}.`);
      }
    } catch (e) {
      problems.push(`GitHub could not be asked about ${branch}: ${errMsg(e)}`);
    }
  }
  const ticket = evidence.flowTicket ?? (closing?.length === 1 ? closing[0] : (recorded?.issue ?? null));
  if (pr !== null && closing !== null && ticket !== null && !closing.includes(ticket)) {
    problems.push(`Pull request #${pr} does not close ticket #${ticket}.`);
  }
  if (recorded !== null && (recorded.pr !== pr || recorded.branch !== branch || recorded.issue !== ticket)) {
    problems.push(`The pickup record names pull request #${recorded.pr} on ${recorded.branch} for ticket #${recorded.issue}.`);
  }
  return { branch, pr, ticket, problems };
}

/** Why the operator's numbers are not this run's pickup, or null when GitHub backs them. */
export async function verifyRunPickup(
  lookup: PullRequestLookup,
  picked: { branch: string | null; pr: number; ticket: number },
): Promise<string | null> {
  if (picked.branch === null) return 'No branch is checked out, so the pull request cannot be checked against it.';
  try {
    return pickupMismatch(await lookup.pullRequest(picked.pr), { pr: picked.pr, branch: picked.branch, issue: picked.ticket });
  } catch (e) {
    return `GitHub could not confirm pull request #${picked.pr}: ${errMsg(e)}`;
  }
}

export interface HeldPickupRun {
  run: RunIdentity;
  /** The ticket run's initial status; null for an adopting run, which has none. */
  initialStatus: string | null;
}

export interface RunPickupConfirmDeps {
  heldRun(repoKey: string): HeldPickupRun | null;
  evidence(repoKey: string): PickupEvidence;
  lookup(repoKey: string): PullRequestLookup;
  trust(repoKey: string, pickup: RunPickup): void;
  changed(): void;
}

export interface RunPickupConfirmations {
  view(repoKey: string): PickupConfirmView | undefined;
  held(repoKey: string): boolean;
  confirm(repoKey: string, run: RunIdentity, pr: number, ticket: number): Promise<ConfirmRunPickupResult>;
}

const NO_LONGER_WAITING = 'This run is no longer waiting for its ticket and pull request.';

export function createRunPickupConfirmations(deps: RunPickupConfirmDeps): RunPickupConfirmations {
  const proposals = new Map<string, { run: RunIdentity; proposal: PickupProposal | null }>();
  const heldAs = (repoKey: string, run: RunIdentity): HeldPickupRun | null => {
    const held = deps.heldRun(repoKey);
    return held !== null && sameRun(held.run, run) ? held : null;
  };
  return {
    view(repoKey) {
      const run = deps.heldRun(repoKey)?.run ?? null;
      if (run === null) {
        proposals.delete(repoKey);
        return undefined;
      }
      const entry = proposals.get(repoKey);
      if (entry === undefined || !sameRun(entry.run, run)) {
        const looking = { run, proposal: null };
        proposals.set(repoKey, looking);
        void proposeRunPickup(deps.evidence(repoKey), deps.lookup(repoKey)).then((proposal) => {
          if (proposals.get(repoKey) !== looking) return;
          proposals.set(repoKey, { run, proposal });
          deps.changed();
        });
        return { run, state: 'looking' };
      }
      if (entry.proposal === null) return { run, state: 'looking' };
      const { adopted, problems, ...proposal } = entry.proposal;
      return {
        run,
        state: 'proposed',
        ...proposal,
        problems: [...problems],
        ...(adopted === undefined ? {} : { adopted: adopted.recoverable ? { recoverable: true, primary: { ...adopted.primary } } : { ...adopted } }),
      };
    },
    held: (repoKey) => deps.heldRun(repoKey) !== null,
    async confirm(repoKey, run, pr, ticket) {
      if (heldAs(repoKey, run) === null) return { ok: false, reason: NO_LONGER_WAITING };
      const evidence = deps.evidence(repoKey);
      if (isAdopting(evidence)) {
        const verified = await verifyAdoptedPickup(evidence, deps.lookup(repoKey), pr, ticket);
        if (!verified.ok) return verified;
        if (heldAs(repoKey, run) === null) return { ok: false, reason: NO_LONGER_WAITING };
        deps.trust(repoKey, verified.pickup);
        proposals.delete(repoKey);
        deps.changed();
        return { ok: true };
      }
      const { branch, flowTicket } = evidence;
      if (flowTicket !== null && ticket !== flowTicket) {
        return { ok: false, reason: `This run is for ticket #${flowTicket}; Terminate the run and Start it again to work on a different ticket.` };
      }
      const refusal = await verifyRunPickup(deps.lookup(repoKey), { branch, pr, ticket });
      if (refusal !== null) return { ok: false, reason: refusal };
      const held = heldAs(repoKey, run);
      if (held === null || held.initialStatus === null || branch === null) return { ok: false, reason: NO_LONGER_WAITING };
      deps.trust(repoKey, { pr, branch, issue: ticket, initialStatus: held.initialStatus });
      proposals.delete(repoKey);
      deps.changed();
      return { ok: true };
    },
  };
}
