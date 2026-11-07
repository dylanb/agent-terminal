import { errMsg } from './errno';
import { matchesGitHubRepositoryUrl, repositoryHost, type GitHubRepositoryIdentity } from './githubRepository';
import { adoptedFixBranch, isPickupBranchName, isRepositoryName, sameTicketRef, type AdoptedPickup, type TicketRef } from '../shared/appBootstrap';

/** A pull request as the adoption start reads it from GitHub. */
export interface AdoptionPullRequest {
  state: string;
  headRef: string;
  baseRef: string;
  /** `<owner>/<name>` of the head repository, lowercased; null when GitHub reports none (a deleted fork). */
  headRepo: string | null;
  crossRepository: boolean;
  closingIssues: Array<{ url: string; number: number }>;
}

/** The adoption start's GitHub: reads only. */
export interface AdoptionGitHub {
  origin(): Promise<GitHubRepositoryIdentity>;
  pullRequest(pr: number): Promise<AdoptionPullRequest>;
}

/** The adoption start's git. Every fetch reaches origin alone. */
export interface AdoptionGit {
  isCleanTree(): Promise<boolean>;
  /** Fetches PR `pr`'s head, which origin serves for a fork's PR too; returns its commit. */
  fetchPullRequestHead(pr: number): Promise<string>;
  fetchBranch(branch: string): Promise<string>;
  mergeBase(a: string, b: string): Promise<string>;
  /** The paths at which commit `oid` tracks the app's loop area, where the run keeps its own state, or puts
   *  anything but a folder in place of the app's state folder; names match in any case or Unicode form. */
  trackedRunStatePaths(oid: string): Promise<string[]>;
  branchExists(branch: string): Promise<boolean>;
  /** Creates `branch` at `oid` and checks it out, overwriting nothing: no branch, and no git-ignored file. */
  createAndCheckOut(branch: string, oid: string): Promise<void>;
  /** Undoes `createAndCheckOut`: the checkout before it is restored, and `branch` is deleted while it is still at
   *  `oid`. */
  rollback(branch: string, oid: string): Promise<void>;
}

export interface AdoptionStartDeps {
  git: AdoptionGit;
  github: AdoptionGitHub;
  prepareRecord(intent: Pick<AdoptedPickup, 'pr' | 'fixBranch'>): void;
  writeRecord(pickup: AdoptedPickup): void;
  clearRecord(): void;
}

export interface AdoptionRequest {
  pr: number;
  /** The adopting run's Start instant. */
  startedAt: number;
  /** The ticket the operator picked as the run's primary, when the PR closes more than one acceptable ticket. */
  pick?: TicketRef;
}

/** What a started adoption owns, so a work entry that fails after it can undo it. */
export interface AdoptionOwnership {
  kind: 'adopted';
  fixBranch: string;
  headOid: string;
}

export type AdoptionStartResult =
  | { ok: true; identity: AdoptedPickup; ownership: AdoptionOwnership }
  | { ok: false; kind: 'error'; error: string; requiresAttention?: true }
  /** The PR closes several acceptable tickets and no pick was made: nothing was touched. */
  | { ok: false; kind: 'choose-ticket'; pr: number; tickets: TicketRef[] };

const OPEN = 'OPEN';

function ownerAndName(repo: string, host: string): GitHubRepositoryIdentity {
  const [owner = '', name = ''] = repo.split('/');
  return { selector: `${host}/${owner}/${name}`, owner, name, defaultBranch: '' };
}

/** The tickets `pr` closes in its base repository (origin) or its head repository, each with its repository. */
export function acceptableTickets(pr: Pick<AdoptionPullRequest, 'headRepo' | 'closingIssues'>, origin: GitHubRepositoryIdentity): TicketRef[] {
  const host = repositoryHost(origin);
  const repositories = [origin, ...(pr.headRepo === null ? [] : [ownerAndName(pr.headRepo, host)])];
  return pr.closingIssues.flatMap((issue) => {
    const repository = repositories.find((r) => matchesGitHubRepositoryUrl(issue.url, r, 'issues', issue.number));
    return repository === undefined ? [] : [{ repo: `${repository.owner}/${repository.name}`, number: issue.number }];
  });
}

/** GitHub's `pr` as the adoption records it — its head repository — or why it cannot be adopted. */
function adoptable(number: number, pr: AdoptionPullRequest): { ok: true; headRepo: string } | { ok: false; reason: string } {
  const refuse = (reason: string) => ({ ok: false as const, reason });
  if (pr.state === 'CLOSED') return refuse(`pull request #${number} is closed`);
  if (pr.state === 'MERGED') return refuse(`pull request #${number} is merged`);
  if (pr.state !== OPEN) return refuse(`pull request #${number} is not open`);
  if (!isPickupBranchName(pr.headRef)) return refuse(`pull request #${number}'s head branch ${pr.headRef} is not a branch name a pickup can record`);
  if (!isPickupBranchName(pr.baseRef)) return refuse(`pull request #${number}'s base branch ${pr.baseRef} is not a branch name a pickup can record`);
  if (pr.headRepo === null) return refuse(`pull request #${number} has no head repository on GitHub`);
  if (!isRepositoryName(pr.headRepo)) return refuse(`pull request #${number}'s head repository ${pr.headRepo} is not a repository name a pickup can record`);
  return { ok: true, headRepo: pr.headRepo };
}

/** Starts a run on an existing pull request: a fix branch of the run's own at the PR head, checked out, and its
 *  pickup record. It writes nothing to GitHub. */
export async function runAdoptionStart(deps: AdoptionStartDeps, req: AdoptionRequest): Promise<AdoptionStartResult> {
  const fail = (error: string): AdoptionStartResult => ({ ok: false, kind: 'error', error });
  if (!Number.isSafeInteger(req.pr) || req.pr <= 0) return fail('adopting a pull request needs a positive pull request number');
  const fixBranch = adoptedFixBranch(req.pr, req.startedAt);
  let created: { headOid: string } | null = null;
  try {
    if (!(await deps.git.isCleanTree())) return fail('working tree is not clean');
    const origin = await deps.github.origin();
    const pr = await deps.github.pullRequest(req.pr);
    const checked = adoptable(req.pr, pr);
    if (!checked.ok) return fail(checked.reason);
    const { headRepo } = checked;
    const tickets = acceptableTickets(pr, origin);
    const repositories = headRepo === `${origin.owner}/${origin.name}` ? `${origin.owner}/${origin.name}` : `${origin.owner}/${origin.name} or ${headRepo}`;
    if (tickets.length === 0) return fail(`pull request #${req.pr} closes no ticket in ${repositories}`);
    const { pick } = req;
    const primary = pick === undefined ? (tickets.length === 1 ? tickets[0] : undefined) : tickets.find((t) => sameTicketRef(t, pick));
    if (pick !== undefined && primary === undefined) {
      return fail(`pull request #${req.pr} does not close ${pick.repo}#${pick.number} in ${repositories}, so it cannot be the run's primary ticket`);
    }
    if (primary === undefined) return { ok: false, kind: 'choose-ticket', pr: req.pr, tickets };
    const headOid = await deps.git.fetchPullRequestHead(req.pr);
    const planted = await deps.git.trackedRunStatePaths(headOid);
    if (planted.length > 0) {
      return fail(`pull request #${req.pr} tracks the app's own run state at ${planted.join(', ')}, which a run never takes from a pull request`);
    }
    const baseTip = await deps.git.fetchBranch(pr.baseRef);
    const baseOid = await deps.git.mergeBase(baseTip, headOid);
    if (await deps.git.branchExists(fixBranch)) {
      return fail(`the run's fix branch ${fixBranch} already exists; Terminate the run and start it again to adopt pull request #${req.pr} on a new fix branch`);
    }
    const identity: AdoptedPickup = {
      kind: 'adopted',
      pr: req.pr,
      host: repositoryHost(origin),
      fixBranch,
      startedAt: req.startedAt,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      headRepo,
      crossRepository: pr.crossRepository,
      tickets,
      primary,
      headOid,
      baseOid,
    };
    deps.prepareRecord({ pr: req.pr, fixBranch });
    created = { headOid };
    await deps.git.createAndCheckOut(fixBranch, headOid);
    deps.writeRecord(identity);
    return { ok: true, identity, ownership: { kind: 'adopted', fixBranch, headOid } };
  } catch (e) {
    const error = errMsg(e);
    if (created === null) return fail(error);
    try {
      await compensateAdoption(deps, { kind: 'adopted', fixBranch, headOid: created.headOid });
      return fail(error);
    } catch (cleanup) {
      return { ok: false, kind: 'error', error: `${error}; ${errMsg(cleanup)}`, requiresAttention: true };
    }
  }
}

/** Undoes a started adoption: the branches and the checkout as they were before it, and no pickup record. */
export async function compensateAdoption(deps: Pick<AdoptionStartDeps, 'git' | 'clearRecord'>, ownership: AdoptionOwnership): Promise<void> {
  try {
    await deps.git.rollback(ownership.fixBranch, ownership.headOid);
  } catch (e) {
    throw new Error(`could not roll back fix branch ${ownership.fixBranch}: ${errMsg(e)}`);
  }
  deps.clearRecord();
}
