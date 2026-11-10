import { isOneOf } from '../shared/oneOf';
import { runAppCommand } from './appCommand';
import { matchesGitHubRepositoryUrl, repositoryHost, type GitHubRepositoryIdentity } from './githubRepository';
import { isRecord } from './yamlRecord';
import type { TicketRef } from '../shared/appBootstrap';

const PULL_REQUEST_STATES = ['OPEN', 'CLOSED', 'MERGED'] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

const isPullRequestState = (value: unknown): value is PullRequestState => isOneOf(PULL_REQUEST_STATES, value);

/** Why the pull request called `name` cannot be worked on in `state`, or null when it is open. */
export function notOpenReason(name: string, state: PullRequestState): string | null {
  const reasons: Record<PullRequestState, string | null> = { OPEN: null, CLOSED: `${name} is closed`, MERGED: `${name} is merged` };
  return reasons[state];
}

export interface GitHubPullRequest {
  number: number;
  state: PullRequestState;
  headRef: string;
  baseRef: string;
  /** `<owner>/<name>` of the head repository, lowercased; null when GitHub reports none (a deleted fork). */
  headRepo: string | null;
  crossRepository: boolean;
  closingIssues: Array<{ url: string; number: number }>;
}

const FIELDS = 'number,url,state,headRefName,baseRefName,headRepository,headRepositoryOwner,isCrossRepository,closingIssuesReferences';

function headRepositoryName(headRepository: unknown, headRepositoryOwner: unknown): string | null {
  const name = isRecord(headRepository) && typeof headRepository.name === 'string' ? headRepository.name : null;
  const owner = isRecord(headRepositoryOwner) && typeof headRepositoryOwner.login === 'string' ? headRepositoryOwner.login : null;
  return name === null || owner === null ? null : `${owner}/${name}`.toLowerCase();
}

/** GitHub's answer for pull request `expected` in `origin`, or a thrown reason when it is not that pull request's. */
export function parseGitHubPullRequest(raw: string, expected: number, origin: GitHubRepositoryIdentity): GitHubPullRequest {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error(`GitHub returned pull request #${expected} in a form that is not JSON`);
  }
  if (!isRecord(doc)) throw new Error(`GitHub returned pull request #${expected} in a form that is not an object`);
  const { number, url, state, headRefName, baseRefName, headRepository, headRepositoryOwner, isCrossRepository, closingIssuesReferences } = doc;
  if (number !== expected || typeof url !== 'string' || !matchesGitHubRepositoryUrl(url, origin, 'pull', expected)) {
    throw new Error(`GitHub answered for a pull request other than #${expected} in ${origin.owner}/${origin.name}`);
  }
  if (!isPullRequestState(state)) throw new Error(`GitHub returned pull request #${expected} in state ${String(state)}, which is not one a pull request has`);
  if (typeof headRefName !== 'string' || typeof baseRefName !== 'string' || typeof isCrossRepository !== 'boolean') {
    throw new Error(`GitHub returned pull request #${expected} without its branches and fork flag`);
  }
  if (!Array.isArray(closingIssuesReferences)) throw new Error(`GitHub returned pull request #${expected} without its closing tickets`);
  const closingIssues = closingIssuesReferences.map((issue: unknown) => {
    if (!isRecord(issue) || !Number.isSafeInteger(issue.number) || (issue.number as number) <= 0 || typeof issue.url !== 'string') {
      throw new Error(`GitHub returned a closing ticket of pull request #${expected} that cannot be read`);
    }
    return { url: issue.url, number: issue.number as number };
  });
  return {
    number: expected,
    state,
    headRef: headRefName,
    baseRef: baseRefName,
    headRepo: headRepositoryName(headRepository, headRepositoryOwner),
    crossRepository: isCrossRepository,
    closingIssues,
  };
}

export async function readGitHubPullRequest(repoDir: string, origin: GitHubRepositoryIdentity, number: number): Promise<GitHubPullRequest> {
  return parseGitHubPullRequest(await runAppCommand('gh', ['pr', 'view', String(number), '--repo', origin.selector, '--json', FIELDS], repoDir), number, origin);
}

function ownerAndName(repo: string, host: string): GitHubRepositoryIdentity {
  const [owner = '', name = ''] = repo.split('/');
  return { selector: `${host}/${owner}/${name}`, owner, name, defaultBranch: '' };
}

/** The tickets `pr` closes in its base repository (origin) or its head repository, each with its repository. */
export function acceptableTickets(pr: Pick<GitHubPullRequest, 'headRepo' | 'closingIssues'>, origin: GitHubRepositoryIdentity): TicketRef[] {
  const host = repositoryHost(origin);
  const repositories = [origin, ...(pr.headRepo === null ? [] : [ownerAndName(pr.headRepo, host)])];
  return pr.closingIssues.flatMap((issue) => {
    const repository = repositories.find((r) => matchesGitHubRepositoryUrl(issue.url, r, 'issues', issue.number));
    return repository === undefined ? [] : [{ repo: `${repository.owner}/${repository.name}`, number: issue.number }];
  });
}
