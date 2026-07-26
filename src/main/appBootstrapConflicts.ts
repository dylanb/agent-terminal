import { parseAppGitObjectId } from './appCommand';
import { run } from './appBootstrapCommand';
import {
  sameAppBootstrapConflictTarget,
  type AppBootstrapConflictTarget,
} from '../shared/appBootstrap';
import { isRecord } from './yamlRecord';
import {
  matchesGitHubRepositoryUrl,
  validGitHubRepositorySelector,
  type GitHubRepositorySource,
  type ResolvedGitHubRepository,
} from './githubRepository';
import type {
  AppBootstrapBranchState,
  AppBootstrapConflicts,
  AppBootstrapGit,
} from './bootstrapPorts';

export interface AppBootstrapConflictStore {
  inspect(branch: string): Promise<AppBootstrapConflictTarget>;
  deleteBranch(branch: string, state: AppBootstrapBranchState): Promise<void>;
  closePullRequest(
    repository: string,
    branch: string,
    pullRequest: number,
  ): Promise<void>;
}

export function createAppBootstrapConflicts(
  store: AppBootstrapConflictStore,
): AppBootstrapConflicts {
  const inspect = async (branch: string): Promise<AppBootstrapConflictTarget> => {
    const target = await store.inspect(branch);
    if (
      target.branch !== branch ||
      !validGitHubRepositorySelector(target.repository)
    ) {
      throw new Error('invalid bootstrap conflict identity');
    }
    const localOid =
      target.localOid === null
        ? null
        : parseAppGitObjectId(target.localOid, 'local branch');
    const remoteOid =
      target.remoteOid === null
        ? null
        : parseAppGitObjectId(target.remoteOid, 'remote branch');
    const pullRequests = [...target.pullRequests];
    if (
      pullRequests.some((number) => !Number.isSafeInteger(number) || number <= 0)
    ) {
      throw new Error('invalid open pull request identity');
    }
    pullRequests.sort((left, right) => left - right);
    if (new Set(pullRequests).size !== pullRequests.length) {
      throw new Error('duplicate open pull request number');
    }
    return {
      repository: target.repository.toLowerCase(),
      branch,
      localOid,
      remoteOid,
      pullRequests,
    };
  };

  return {
    inspect,
    wipe: async (target) => {
      const current = await inspect(target.branch);
      if (!sameAppBootstrapConflictTarget(current, target)) {
        throw new Error(
          `conflicting resources changed for branch ${target.branch}`,
        );
      }

      if (target.localOid !== null || target.remoteOid !== null) {
        await store.deleteBranch(target.branch, {
          localOid: target.localOid,
          remoteOid: target.remoteOid,
        });
      }
      for (const pullRequest of target.pullRequests) {
        await store.closePullRequest(
          target.repository,
          target.branch,
          pullRequest,
        );
      }

      const remaining = await inspect(target.branch);
      if (
        remaining.localOid !== null ||
        remaining.remoteOid !== null ||
        remaining.pullRequests.length > 0
      ) {
        throw new Error(
          `could not completely wipe conflicting resources for branch ${target.branch}`,
        );
      }
    },
  };
}

function createRealAppBootstrapConflictStore(
  repoDir: string,
  git: AppBootstrapGit,
  repository: ResolvedGitHubRepository,
): AppBootstrapConflictStore {
  const gh = (args: string[], failure: string): Promise<string> =>
    run('gh', args, repoDir, failure);
  const expectedPullRequestHeads = new Map<string, string>();
  const pullRequestKey = (branch: string, pullRequest: number): string =>
    `${branch}\0${pullRequest}`;
  return {
    inspect: async (branch) => {
      expectedPullRequestHeads.clear();
      let raw: unknown;
      try {
        raw = JSON.parse(
          await gh(
            [
              'pr',
              'list',
              '--repo',
              repository.selector,
              '--head',
              branch,
              '--state',
              'open',
              '--limit',
              '1000',
              '--json',
              'number,url,headRefOid,isCrossRepository,headRepository,headRepositoryOwner',
            ],
            'open pull request lookup failed',
          ),
        );
      } catch (e) {
        if (e instanceof SyntaxError) {
          throw new Error('invalid open pull request list');
        }
        throw e;
      }
      if (!Array.isArray(raw)) throw new Error('invalid open pull request list');
      const pullRequests: number[] = [];
      for (const entry of raw) {
        if (
          !isRecord(entry) ||
          typeof entry.number !== 'number' ||
          typeof entry.url !== 'string' ||
          typeof entry.headRefOid !== 'string' ||
          typeof entry.isCrossRepository !== 'boolean' ||
          !isRecord(entry.headRepository) ||
          typeof entry.headRepository.name !== 'string' ||
          !isRecord(entry.headRepositoryOwner) ||
          typeof entry.headRepositoryOwner.login !== 'string'
        ) {
          throw new Error('invalid open pull request identity');
        }
        if (entry.isCrossRepository) continue;
        const headOid = parseAppGitObjectId(
          entry.headRefOid,
          'pull request head',
        );
        if (
          entry.headRepositoryOwner.login.trim().toLowerCase() !==
            repository.owner ||
          entry.headRepository.name.trim().toLowerCase() !== repository.name ||
          !matchesGitHubRepositoryUrl(entry.url, repository, 'pull', entry.number)
        ) {
          throw new Error(
            'same-repository pull request has a mismatched identity',
          );
        }
        pullRequests.push(entry.number);
        expectedPullRequestHeads.set(
          pullRequestKey(branch, entry.number),
          headOid,
        );
      }
      const state = await git.branchState(branch);
      return {
        repository: repository.selector,
        branch,
        localOid: state.localOid,
        remoteOid: state.remoteOid,
        pullRequests,
      };
    },
    deleteBranch: (branch, state) => git.deleteBranch(branch, state),
    closePullRequest: async (repositorySelector, branch, pullRequest) => {
      if (repositorySelector !== repository.selector) {
        throw new Error('conflict repository changed before PR close');
      }
      const expectedHeadOid = expectedPullRequestHeads.get(
        pullRequestKey(branch, pullRequest),
      );
      if (expectedHeadOid === undefined) {
        throw new Error('pull request was not freshly inspected');
      }
      let raw: unknown;
      try {
        raw = JSON.parse(
          await gh(
            [
              'pr',
              'view',
              String(pullRequest),
              '--repo',
              repository.selector,
              '--json',
              'number,url,state,headRefOid,isCrossRepository,headRefName,headRepository,headRepositoryOwner',
            ],
            'pull request lookup failed',
          ),
        );
      } catch (e) {
        if (e instanceof SyntaxError) {
          throw new Error('pull request changed before close');
        }
        throw e;
      }
      if (
        !isRecord(raw) ||
        raw.number !== pullRequest ||
        typeof raw.url !== 'string' ||
        !matchesGitHubRepositoryUrl(raw.url, repository, 'pull', pullRequest) ||
        typeof raw.state !== 'string' ||
        typeof raw.headRefOid !== 'string' ||
        parseAppGitObjectId(raw.headRefOid, 'pull request head') !==
          expectedHeadOid ||
        raw.isCrossRepository !== false ||
        raw.headRefName !== branch ||
        !isRecord(raw.headRepository) ||
        typeof raw.headRepository.name !== 'string' ||
        raw.headRepository.name.trim().toLowerCase() !== repository.name ||
        !isRecord(raw.headRepositoryOwner) ||
        typeof raw.headRepositoryOwner.login !== 'string' ||
        raw.headRepositoryOwner.login.trim().toLowerCase() !== repository.owner
      ) {
        throw new Error('pull request changed before close');
      }
      if (raw.state === 'CLOSED') return;
      if (raw.state !== 'OPEN') throw new Error('pull request is not open');
      await gh(
        ['pr', 'close', String(pullRequest), '--repo', repository.selector],
        'pull request close failed',
      );
    },
  };
}

export function createRealAppBootstrapConflicts(
  repoDir: string,
  git: AppBootstrapGit,
  repositorySource: GitHubRepositorySource,
): AppBootstrapConflicts {
  let conflicts: AppBootstrapConflicts | undefined;
  const resolve = async (): Promise<AppBootstrapConflicts> => {
    if (conflicts === undefined) {
      conflicts = createAppBootstrapConflicts(
        createRealAppBootstrapConflictStore(
          repoDir,
          git,
          await repositorySource.resolve(),
        ),
      );
    }
    return conflicts;
  };
  return {
    inspect: async (branch) => (await resolve()).inspect(branch),
    wipe: async (target) => (await resolve()).wipe(target),
  };
}
