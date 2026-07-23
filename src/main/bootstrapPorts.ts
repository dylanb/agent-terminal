import { execFile } from 'node:child_process';
import { APP_STATE_DIRS } from './appStateDirs';
import { numberFromGithubUrl } from '../shared/githubUrl';
import {
  sameAppBootstrapConflictTarget,
  type AppBootstrapConflictTarget,
} from '../shared/appBootstrap';
import { isRecord } from './yamlRecord';

export interface BootstrapIssue {
  title: string;
  url: string;
}

export interface BootstrapGit {
  isCleanTree(): Promise<boolean>;
  resolveBaseBranch(): Promise<string | null>;
  branchExists(branch: string): Promise<boolean>;
  createBranchFromBase(branch: string, base: string): Promise<void>;
  commitEmptyStart(message: string): Promise<void>;
  pushBranchUpstream(branch: string): Promise<void>;
}

export interface BootstrapBranchWiper {
  wipeConflictingBranch(branch: string): Promise<void>;
}

export interface BootstrapBranchRollback {
  rollbackCreatedBranch(branch: string): Promise<void>;
}

export interface AppBootstrapConflicts {
  inspect(branch: string): Promise<AppBootstrapConflictTarget>;
  wipe(target: AppBootstrapConflictTarget): Promise<void>;
}

export interface AppBootstrapConflictRunners {
  git(args: string[]): Promise<string>;
  gh(args: string[]): Promise<string>;
}

export interface BootstrapGitHub {
  viewIssue(issue: number): Promise<BootstrapIssue | null>;
  assignIssueToSelf(issue: number): Promise<void>;
  setIssueLabel(issue: number, label: string, on: boolean): Promise<void>;
  createDraftPr(args: { base: string; head: string; title: string; body: string }): Promise<number | null>;
  setPrLabel(pr: number, label: string, on: boolean): Promise<void>;
}

const EXEC_TIMEOUT_MS = 60_000;

function run(file: 'git' | 'gh', args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      if (!err) {
        resolve(stdout);
        return;
      }
      const classification =
        typeof err.code === 'number' &&
        Number.isInteger(err.code) &&
        err.code >= 0 &&
        err.code <= 255
          ? `exit ${err.code}`
          : err.killed
            ? 'timed out'
            : 'could not start';
      reject(new Error(`${file} command failed (${classification})`));
    });
  });
}

const APP_STATE_PREFIXES = APP_STATE_DIRS.map((d) => `${d}/`);

function treeIsClean(porcelain: string): boolean {
  const isAppState = (p: string): boolean => APP_STATE_PREFIXES.some((prefix) => p.startsWith(prefix));
  return porcelain
    .split('\n')
    .filter((line) => line.length > 0)
    .every((line) => line.slice(3).split(' -> ').every(isAppState));
}

export function createRealBootstrapGit(repoDir: string): BootstrapGit & BootstrapBranchWiper & BootstrapBranchRollback {
  const git = (args: string[]): Promise<string> => run('git', args, repoDir);
  const bestEffortGit = async (args: string[]): Promise<void> => {
    try {
      await git(args);
    } catch {
      // A branch already absent on one side of cleanup is the target state.
    }
  };
  return {
    isCleanTree: async () => treeIsClean(await git(['status', '--porcelain'])),
    resolveBaseBranch: async () => {
      try {
        const out = await run('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], repoDir);
        const name = out.trim();
        return name.length > 0 ? name : null;
      } catch {
        return null;
      }
    },
    branchExists: async (branch) => {
      const local = await git(['branch', '--list', branch]);
      if (local.trim().length > 0) return true;
      try {
        const remote = await run('git', ['ls-remote', '--heads', 'origin', branch], repoDir);
        return remote.trim().length > 0;
      } catch {
        return false;
      }
    },
    wipeConflictingBranch: async (branch) => {
      await bestEffortGit(['checkout', '--detach']);
      await bestEffortGit(['branch', '-D', branch]);
      await bestEffortGit(['push', 'origin', '--delete', branch]);
    },
    rollbackCreatedBranch: async (branch) => {
      const local = await git(['branch', '--list', branch]);
      if (local.trim().length > 0) {
        await git(['checkout', '--detach']);
        await git(['branch', '-D', branch]);
      }
      const remote = await git(['ls-remote', '--heads', 'origin', branch]);
      if (remote.trim().length > 0) {
        await git(['push', 'origin', '--delete', branch]);
      }
    },
    createBranchFromBase: async (branch, base) => {
      await git(['fetch', 'origin', base]);
      await git(['checkout', '-b', branch, 'FETCH_HEAD']);
    },
    commitEmptyStart: async (message) => void (await git(['commit', '--allow-empty', '-m', message])),
    pushBranchUpstream: async (branch) => void (await git(['push', '-u', 'origin', branch])),
  };
}

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function parseObjectId(value: string, source: string): string {
  const oid = value.trim().toLowerCase();
  if (!OBJECT_ID.test(oid)) throw new Error(`invalid ${source} object id`);
  return oid;
}

export function createAppBootstrapConflicts({
  git,
  gh,
}: AppBootstrapConflictRunners): AppBootstrapConflicts {
  const inspect = async (branch: string): Promise<AppBootstrapConflictTarget> => {
    const local = await git(['branch', '--list', branch]);
    const localOid =
      local.trim().length === 0
        ? null
        : parseObjectId(
            await git(['rev-parse', '--verify', `refs/heads/${branch}`]),
            'local branch',
          );

    const remote = (await git([
      'ls-remote',
      '--heads',
      'origin',
      `refs/heads/${branch}`,
    ])).trim();
    const remoteOid =
      remote.length === 0
        ? null
        : parseObjectId(remote.split(/\s+/, 1)[0] ?? '', 'remote branch');

    const rawRepository: unknown = JSON.parse(
      await gh(['repo', 'view', '--json', 'nameWithOwner']),
    );
    if (
      !isRecord(rawRepository) ||
      typeof rawRepository.nameWithOwner !== 'string' ||
      rawRepository.nameWithOwner.trim().length === 0
    ) {
      throw new Error('invalid repository identity');
    }
    const repository = rawRepository.nameWithOwner.trim().toLowerCase();
    const repositorySeparator = repository.indexOf('/');
    if (
      repositorySeparator <= 0 ||
      repositorySeparator !== repository.lastIndexOf('/') ||
      repositorySeparator === repository.length - 1
    ) {
      throw new Error('invalid repository identity');
    }
    const repositoryOwner = repository.slice(0, repositorySeparator);
    const repositoryName = repository.slice(repositorySeparator + 1);

    const rawPullRequests: unknown = JSON.parse(
      await gh([
        'pr',
        'list',
        '--head',
        branch,
        '--state',
        'open',
        '--limit',
        '1000',
        '--json',
        'number,isCrossRepository,headRepository,headRepositoryOwner',
      ]),
    );
    if (!Array.isArray(rawPullRequests)) {
      throw new Error('invalid open pull request list');
    }
    const pullRequests: number[] = [];
    for (const entry of rawPullRequests) {
      const number = isRecord(entry) ? entry.number : null;
      if (
        typeof number !== 'number' ||
        !Number.isSafeInteger(number) ||
        number <= 0 ||
        typeof entry.isCrossRepository !== 'boolean' ||
        !isRecord(entry.headRepository) ||
        typeof entry.headRepository.name !== 'string' ||
        !isRecord(entry.headRepositoryOwner) ||
        typeof entry.headRepositoryOwner.login !== 'string'
      ) {
        throw new Error('invalid open pull request identity');
      }
      if (entry.isCrossRepository) continue;
      if (
        entry.headRepositoryOwner.login.trim().toLowerCase() !==
          repositoryOwner ||
        entry.headRepository.name.trim().toLowerCase() !== repositoryName
      ) {
        throw new Error('same-repository pull request has a mismatched head repository');
      }
      pullRequests.push(number);
    }
    pullRequests.sort((left, right) => left - right);
    if (new Set(pullRequests).size !== pullRequests.length) {
      throw new Error('duplicate open pull request number');
    }
    return { branch, localOid, remoteOid, pullRequests };
  };

  return {
    inspect,
    wipe: async (target) => {
      const current = await inspect(target.branch);
      if (!sameAppBootstrapConflictTarget(current, target)) {
        throw new Error(`conflicting resources changed for branch ${target.branch}`);
      }

      for (const pr of target.pullRequests) {
        await gh(['pr', 'close', String(pr)]);
      }
      if (target.localOid !== null) {
        const currentBranch = (
          await git(['branch', '--show-current'])
        ).trim();
        if (currentBranch === target.branch) {
          await git(['checkout', '--detach', target.localOid]);
        }
        await git([
          'update-ref',
          '-d',
          `refs/heads/${target.branch}`,
          target.localOid,
        ]);
      }
      if (target.remoteOid !== null) {
        await git([
          'push',
          'origin',
          `--force-with-lease=refs/heads/${target.branch}:${target.remoteOid}`,
          `:refs/heads/${target.branch}`,
        ]);
      }

      const remaining = await inspect(target.branch);
      if (
        remaining.localOid !== null ||
        remaining.remoteOid !== null ||
        remaining.pullRequests.length > 0
      ) {
        throw new Error(`could not completely wipe conflicting resources for branch ${target.branch}`);
      }
    },
  };
}

export function createRealAppBootstrapConflicts(
  repoDir: string,
): AppBootstrapConflicts {
  return createAppBootstrapConflicts({
    git: (args) => run('git', args, repoDir),
    gh: (args) => run('gh', args, repoDir),
  });
}

export function createRealBootstrapGitHub(repoDir: string): BootstrapGitHub {
  const gh = (args: string[]): Promise<string> => run('gh', args, repoDir);
  return {
    viewIssue: async (issue) => {
      try {
        const parsed = JSON.parse(await gh(['issue', 'view', String(issue), '--json', 'title,url']));
        if (typeof parsed?.title === 'string' && typeof parsed?.url === 'string') {
          return { title: parsed.title, url: parsed.url };
        }
        return null;
      } catch {
        return null;
      }
    },
    assignIssueToSelf: async (issue) => void (await gh(['issue', 'edit', String(issue), '--add-assignee', '@me'])),
    setIssueLabel: async (issue, label, on) =>
      void (await gh(['issue', 'edit', String(issue), on ? '--add-label' : '--remove-label', label])),
    createDraftPr: async ({ base, head, title, body }) => {
      const out = await gh(['pr', 'create', '--draft', '--base', base, '--head', head, '--title', title, '--body', body]);
      return numberFromGithubUrl(out);
    },
    setPrLabel: async (pr, label, on) =>
      void (await gh(['pr', 'edit', String(pr), on ? '--add-label' : '--remove-label', label])),
  };
}
