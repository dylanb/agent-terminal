// §27.13 v2.211 — a run past its pickup that has no saved pickup is held until the operator confirms the ticket and
// pull request the app works out from the checked-out branch, GitHub and the flow's own ticket input.

import { errMsg } from './errno';
import { sameRun, type RunIdentity } from './gateRunState';
import { pickupMismatch, type PullRequestLookup } from './pullRequestLookup';
import type { AppLoopBootstrap, PickupRecord } from './appLoopState';
import type { ConfirmRunPickupResult, PickupConfirmView } from '../shared/ipc';

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

export const RESTART_KEEPS_PICKUP =
  'Not restarted: the run’s saved pull request could not be removed, and the restarted run would trust it again. Remove .agent-terminal/loop/run-pickup.yaml and Restart, or Terminate and Start.';

export interface PickupHoldFacts {
  run: RunIdentity | null;
  pickupInFlight: boolean;
  pickupStep: 'none' | 'behind' | 'current';
  /** This app started or restarted the run, so nothing about its pickup was lost to a relaunch. */
  runBegunHere: boolean;
  flowRefs: { ticket: number | null; pr: number | null };
  bootstrapRecord: PickupRecord;
}

export function awaitingPickupConfirm(f: PickupHoldFacts): RunIdentity | null {
  if (f.run === null || f.pickupInFlight || f.pickupStep === 'none' || f.runBegunHere) return null;
  const record = f.bootstrapRecord;
  const { ticket, pr } = f.flowRefs;
  const recordAgrees = record.kind === 'none' || (record.kind === 'complete' && record.bootstrap.pr === pr && record.bootstrap.issue === ticket);
  if (ticket !== null && pr !== null && recordAgrees) return null;
  if (f.pickupStep === 'behind') return f.run;
  if (record.kind === 'pending') return f.run;
  return record.kind === 'complete' && ticket !== null && record.bootstrap.issue === ticket ? f.run : null;
}

export interface PickupEvidence {
  branch: string | null;
  flowTicket: number | null;
  bootstrapRecord: PickupRecord;
}

export interface PickupProposal {
  branch: string | null;
  pr: number | null;
  ticket: number | null;
  problems: string[];
}

export async function proposeRunPickup(evidence: PickupEvidence, lookup: PullRequestLookup): Promise<PickupProposal> {
  const problems: string[] = [];
  const record = evidence.bootstrapRecord;
  const recorded = record.kind === 'complete' ? record.bootstrap : null;
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
  initialStatus: string;
}

export interface RunPickupConfirmDeps {
  heldRun(repoKey: string): HeldPickupRun | null;
  evidence(repoKey: string): PickupEvidence;
  lookup(repoKey: string): PullRequestLookup;
  trust(repoKey: string, pickup: AppLoopBootstrap): void;
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
      return entry.proposal === null ? { run, state: 'looking' } : { run, state: 'proposed', ...entry.proposal };
    },
    held: (repoKey) => deps.heldRun(repoKey) !== null,
    async confirm(repoKey, run, pr, ticket) {
      if (heldAs(repoKey, run) === null) return { ok: false, reason: NO_LONGER_WAITING };
      const { branch, flowTicket } = deps.evidence(repoKey);
      if (flowTicket !== null && ticket !== flowTicket) {
        return { ok: false, reason: `This run is for ticket #${flowTicket}; Terminate the run and Start it again to work on a different ticket.` };
      }
      const refusal = await verifyRunPickup(deps.lookup(repoKey), { branch, pr, ticket });
      if (refusal !== null) return { ok: false, reason: refusal };
      const held = heldAs(repoKey, run);
      if (held === null || branch === null) return { ok: false, reason: NO_LONGER_WAITING };
      deps.trust(repoKey, { pr, branch, issue: ticket, initialStatus: held.initialStatus });
      proposals.delete(repoKey);
      deps.changed();
      return { ok: true };
    },
  };
}
