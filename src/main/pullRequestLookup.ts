import { runAppCommand } from './appCommand';
import {
  createGitHubRepositorySource,
  matchesGitHubRepositoryUrl,
  type GitHubRepositoryIdentity,
} from './githubRepository';
import { isRecord } from './yamlRecord';
import { isGitObjectId } from '../shared/appBootstrap';

export interface PullRequest {
  number: number;
  branch: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  closingIssues: number[];
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
  if (pr.state !== 'OPEN') return `pull request #${pr.number} is not open (${pr.state.toLowerCase()})`;
  if (pr.branch !== pickup.branch) return `pull request #${pr.number} is on ${pr.branch}, not ${pickup.branch}`;
  if (!pr.closingIssues.includes(pickup.issue)) return `pull request #${pr.number} does not close ticket #${pickup.issue}`;
  return null;
}

export function createRealPullRequestLookup(repoDir: string): PullRequestLookup {
  const repositorySource = createGitHubRepositorySource(repoDir);
  return {
    async pullRequest(number) {
      const identity = await repositorySource.resolve();
      const viewed = await runAppCommand(
        'gh',
        ['pr', 'view', String(number), '--repo', identity.selector, '--json', 'number,url,headRefName,state,closingIssuesReferences,isCrossRepository'],
        repoDir,
      );
      return parsePullRequest(parseJson(viewed, 'invalid GitHub pull request identity'), number, identity);
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

/** Every open pull request whose head is `branch`, fork-headed ones included. */
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

function parsePullRequest(value: unknown, expectedNumber: number, repository: GitHubRepositoryIdentity): PullRequest {
  if (
    !isRecord(value) ||
    value.number !== expectedNumber ||
    typeof value.url !== 'string' ||
    !matchesGitHubRepositoryUrl(value.url, repository, 'pull', expectedNumber) ||
    typeof value.headRefName !== 'string' ||
    (value.state !== 'OPEN' && value.state !== 'CLOSED' && value.state !== 'MERGED') ||
    !Array.isArray(value.closingIssuesReferences) ||
    typeof value.isCrossRepository !== 'boolean'
  ) {
    throw new Error('invalid GitHub pull request identity');
  }
  const closingIssues = value.closingIssuesReferences.map((entry) => {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.number) ||
      (entry.number as number) <= 0 ||
      typeof entry.url !== 'string' ||
      !matchesGitHubRepositoryUrl(entry.url, repository, 'issues', entry.number as number)
    ) {
      throw new Error('invalid GitHub closing issue identity');
    }
    return entry.number as number;
  });
  return { number: expectedNumber, branch: value.headRefName, state: value.state, closingIssues, crossRepository: value.isCrossRepository };
}
