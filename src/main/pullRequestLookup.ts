import { runAppCommand } from './appCommand';
import { createGitHubRepositorySource, matchesGitHubRepositoryUrl } from './githubRepository';
import { isRecord } from './yamlRecord';
import { isGitObjectId, type TicketRef } from '../shared/appBootstrap';
import { acceptableTickets, notOpenReason, readGitHubPullRequest, type PullRequestState } from './githubPullRequest';

export interface PullRequest {
  number: number;
  branch: string;
  state: PullRequestState;
  /** The numbers of the tickets it closes in origin. */
  closingIssues: number[];
  /** The tickets it closes in origin or a fork's head repository, each with its repository; a ticket elsewhere is
   *  left out. Absent when the source does not say which repository a ticket is in. */
  closingTickets?: TicketRef[];
  crossRepository: boolean;
}

export interface PullRequestLookup {
  pullRequest(number: number): Promise<PullRequest>;
  /** The open, same-repository pull requests whose head is `branch`. */
  openForBranch(branch: string): Promise<number[]>;
}

/** §27.10 — why `pr` is not the pull request a run's pickup opened, or null when it is. */
export function pickupMismatch(pr: PullRequest, pickup: { pr: number; branch: string; issue: number }): string | null {
  if (pr.number !== pickup.pr) return `GitHub answered for #${pr.number}, not #${pickup.pr}`;
  if (pr.crossRepository) return `pull request #${pr.number} is from another repository`;
  const closed = notOpenReason(`pull request #${pr.number}`, pr.state);
  if (closed !== null) return closed;
  if (pr.branch !== pickup.branch) return `pull request #${pr.number} is on ${pr.branch}, not ${pickup.branch}`;
  if (!pr.closingIssues.includes(pickup.issue)) return `pull request #${pr.number} does not close ticket #${pickup.issue}`;
  return null;
}

/** What a PR read does with a closing ticket outside origin and a fork's head repository: a ticket run's identity
 *  check refuses the PR, as it always has; an adopting run ignores the ticket, as its start and publish do. */
export type TicketsElsewhere = 'refuse' | 'ignore';

export function createRealPullRequestLookup(repoDir: string, ticketsElsewhere: TicketsElsewhere = 'refuse'): PullRequestLookup {
  const repositorySource = createGitHubRepositorySource(repoDir);
  return {
    async pullRequest(number) {
      const origin = await repositorySource.resolve();
      const pr = await readGitHubPullRequest(repoDir, origin, number);
      const closingTickets = acceptableTickets(pr, origin);
      if (ticketsElsewhere === 'refuse' && closingTickets.length !== pr.closingIssues.length) {
        throw new Error(`pull request #${number} closes a ticket outside ${origin.owner}/${origin.name} and its head repository`);
      }
      const closingIssues = pr.closingIssues.filter((r) => matchesGitHubRepositoryUrl(r.url, origin, 'issues', r.number)).map((r) => r.number);
      return { number, branch: pr.headRef, state: pr.state, closingIssues, closingTickets, crossRepository: pr.crossRepository };
    },
    async openForBranch(branch) {
      const identity = await repositorySource.resolve();
      const listed = await runAppCommand(
        'gh',
        ['pr', 'list', '--repo', identity.selector, '--head', branch, '--state', 'open', '--limit', '1000', '--json', 'number,url,isCrossRepository'],
        repoDir,
      );
      const raw = parseJson(listed, 'invalid GitHub pull request list');
      if (!Array.isArray(raw)) throw new Error('invalid GitHub pull request list');
      return raw
        .filter(
          (entry): entry is { number: number; url: string } =>
            isRecord(entry) &&
            entry.isCrossRepository === false &&
            Number.isSafeInteger(entry.number) &&
            (entry.number as number) > 0 &&
            typeof entry.url === 'string' &&
            matchesGitHubRepositoryUrl(entry.url, identity, 'pull', entry.number as number),
        )
        .map((entry) => entry.number);
    },
  };
}

export interface BranchPullRequest {
  number: number;
  headSha: string;
  crossRepository: boolean;
}

export async function openPullRequestsForBranch(repoDir: string, branch: string): Promise<BranchPullRequest[]> {
  const identity = await createGitHubRepositorySource(repoDir).resolve();
  const listed = await runAppCommand(
    'gh',
    ['pr', 'list', '--repo', identity.selector, '--head', branch, '--state', 'open', '--limit', '1000', '--json', 'number,url,headRefOid,isCrossRepository'],
    repoDir,
  );
  const raw = parseJson(listed, 'invalid GitHub pull request list');
  if (!Array.isArray(raw)) throw new Error('invalid GitHub pull request list');
  return raw.map((entry) => {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.number) ||
      (entry.number as number) <= 0 ||
      typeof entry.url !== 'string' ||
      !matchesGitHubRepositoryUrl(entry.url, identity, 'pull', entry.number as number) ||
      typeof entry.headRefOid !== 'string' ||
      !isGitObjectId(entry.headRefOid) ||
      typeof entry.isCrossRepository !== 'boolean'
    ) {
      throw new Error('invalid GitHub pull request list');
    }
    return { number: entry.number as number, headSha: entry.headRefOid, crossRepository: entry.isCrossRepository };
  });
}

function parseJson(text: string, invalid: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(invalid);
  }
}
