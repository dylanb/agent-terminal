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

export interface AppBootstrapRepositoryIdentity {
  selector: string;
  owner: string;
  name: string;
}

export interface AppBootstrapOpenPullRequest {
  number: number;
  crossRepository: boolean;
  headOwner: string;
  headRepository: string;
}

export interface AppBootstrapConflictResources {
  localObjectId(branch: string): Promise<string | null>;
  remoteObjectId(branch: string): Promise<string | null>;
  repositoryIdentity(): Promise<AppBootstrapRepositoryIdentity>;
  openPullRequests(
    repository: string,
    branch: string,
  ): Promise<AppBootstrapOpenPullRequest[]>;
  closePullRequest(repository: string, pullRequest: number): Promise<void>;
  currentBranch(): Promise<string | null>;
  detach(oid: string): Promise<void>;
  deleteLocalBranch(branch: string, expectedOid: string): Promise<void>;
  deleteRemoteBranch(branch: string, expectedOid: string): Promise<void>;
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
    const environment = { ...process.env };
    delete environment.GH_REPO;
    execFile(file, args, { cwd, timeout: EXEC_TIMEOUT_MS, env: environment }, (err, stdout) => {
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
    .every((line) => {
      const indexState = line[0];
      if (indexState !== ' ' && indexState !== '?') return false;
      if (indexState === '?' && line[1] !== '?') return false;
      return line.slice(3).split(' -> ').every(isAppState);
    });
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
    commitEmptyStart: async (message) => {
      const parent = parseObjectId(
        await git(['rev-parse', '--verify', 'HEAD']),
        'bootstrap parent',
      );
      const tree = parseObjectId(
        await git(['rev-parse', '--verify', 'HEAD^{tree}']),
        'bootstrap tree',
      );
      const commit = parseObjectId(
        await git(['commit-tree', tree, '-p', parent, '-m', message]),
        'bootstrap commit',
      );
      await git(['update-ref', 'HEAD', commit, parent]);
    },
    pushBranchUpstream: async (branch) => void (await git(['push', '-u', 'origin', branch])),
  };
}

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function parseObjectId(value: string, source: string): string {
  const oid = value.trim().toLowerCase();
  if (!OBJECT_ID.test(oid)) throw new Error(`invalid ${source} object id`);
  return oid;
}

const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;

function repositoryFromRemote(
  value: string,
): AppBootstrapRepositoryIdentity | null {
  const remote = value.trim();
  let host: string;
  let repositoryPath: string;
  const scp = /^[^@]+@([^:]+):(.+)$/.exec(remote);
  if (scp) {
    host = scp[1] ?? '';
    repositoryPath = scp[2] ?? '';
  } else {
    try {
      const parsed = new URL(remote);
      host = parsed.hostname;
      repositoryPath = parsed.pathname.replace(/^\/+/, '');
    } catch {
      return null;
    }
  }
  repositoryPath = repositoryPath.replace(/\.git$/, '');
  const parts = repositoryPath.split('/');
  if (
    parts.length !== 2 ||
    !REPOSITORY_PART.test(host) ||
    !REPOSITORY_PART.test(parts[0] ?? '') ||
    !REPOSITORY_PART.test(parts[1] ?? '')
  ) {
    return null;
  }
  const owner = (parts[0] ?? '').toLowerCase();
  const name = (parts[1] ?? '').toLowerCase();
  return {
    selector: `${host.toLowerCase()}/${owner}/${name}`,
    owner,
    name,
  };
}

function validRepositoryIdentity(
  identity: AppBootstrapRepositoryIdentity,
): boolean {
  const parts = identity.selector.split('/');
  return (
    parts.length === 3 &&
    REPOSITORY_PART.test(parts[0] ?? '') &&
    REPOSITORY_PART.test(parts[1] ?? '') &&
    REPOSITORY_PART.test(parts[2] ?? '') &&
    (parts[1] ?? '').toLowerCase() === identity.owner.toLowerCase() &&
    (parts[2] ?? '').toLowerCase() === identity.name.toLowerCase()
  );
}

export function createAppBootstrapConflicts(
  resources: AppBootstrapConflictResources,
): AppBootstrapConflicts {
  const inspect = async (branch: string): Promise<AppBootstrapConflictTarget> => {
    const local = await resources.localObjectId(branch);
    const remote = await resources.remoteObjectId(branch);
    const localOid =
      local === null ? null : parseObjectId(local, 'local branch');
    const remoteOid =
      remote === null ? null : parseObjectId(remote, 'remote branch');
    const identity = await resources.repositoryIdentity();
    if (!validRepositoryIdentity(identity)) {
      throw new Error('invalid repository identity');
    }
    const repository: AppBootstrapRepositoryIdentity = {
      selector: identity.selector.toLowerCase(),
      owner: identity.owner.toLowerCase(),
      name: identity.name.toLowerCase(),
    };
    const openPullRequests = await resources.openPullRequests(
      repository.selector,
      branch,
    );
    const pullRequests: number[] = [];
    for (const entry of openPullRequests) {
      if (
        !Number.isSafeInteger(entry.number) ||
        entry.number <= 0 ||
        typeof entry.crossRepository !== 'boolean' ||
        typeof entry.headOwner !== 'string' ||
        typeof entry.headRepository !== 'string'
      ) {
        throw new Error('invalid open pull request identity');
      }
      if (entry.crossRepository) continue;
      if (
        entry.headOwner.trim().toLowerCase() !== repository.owner ||
        entry.headRepository.trim().toLowerCase() !== repository.name
      ) {
        throw new Error('same-repository pull request has a mismatched head repository');
      }
      pullRequests.push(entry.number);
    }
    pullRequests.sort((left, right) => left - right);
    if (new Set(pullRequests).size !== pullRequests.length) {
      throw new Error('duplicate open pull request number');
    }
    return {
      repository: repository.selector,
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
        throw new Error(`conflicting resources changed for branch ${target.branch}`);
      }

      for (const pr of target.pullRequests) {
        await resources.closePullRequest(target.repository, pr);
      }
      if (target.localOid !== null) {
        const currentBranch = await resources.currentBranch();
        if (currentBranch === target.branch) {
          await resources.detach(target.localOid);
        }
        await resources.deleteLocalBranch(
          target.branch,
          target.localOid,
        );
      }
      if (target.remoteOid !== null) {
        await resources.deleteRemoteBranch(
          target.branch,
          target.remoteOid,
        );
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

function createRealAppBootstrapConflictResources(
  repoDir: string,
): AppBootstrapConflictResources {
  const git = (args: string[]): Promise<string> => run('git', args, repoDir);
  const gh = (args: string[]): Promise<string> => run('gh', args, repoDir);
  return {
    localObjectId: async (branch) => {
      const local = await git(['branch', '--list', branch]);
      if (local.trim().length === 0) return null;
      return parseObjectId(
        await git(['rev-parse', '--verify', `refs/heads/${branch}`]),
        'local branch',
      );
    },
    remoteObjectId: async (branch) => {
      const remote = (
        await git([
          'ls-remote',
          '--heads',
          'origin',
          `refs/heads/${branch}`,
        ])
      ).trim();
      return remote.length === 0
        ? null
        : parseObjectId(
            remote.split(/\s+/, 1)[0] ?? '',
            'remote branch',
          );
    },
    repositoryIdentity: async () => {
      const expected = repositoryFromRemote(
        await git(['remote', 'get-url', 'origin']),
      );
      if (expected === null) throw new Error('invalid origin repository');
      const raw: unknown = JSON.parse(
        await gh([
          'repo',
          'view',
          expected.selector,
          '--json',
          'nameWithOwner,url',
        ]),
      );
      if (
        !isRecord(raw) ||
        typeof raw.nameWithOwner !== 'string' ||
        typeof raw.url !== 'string'
      ) {
        throw new Error('invalid repository identity');
      }
      const viewed = repositoryFromRemote(raw.url);
      if (
        viewed === null ||
        viewed.selector !== expected.selector ||
        raw.nameWithOwner.trim().toLowerCase() !==
          `${expected.owner}/${expected.name}`
      ) {
        throw new Error('origin repository does not match GitHub');
      }
      return expected;
    },
    openPullRequests: async (repository, branch) => {
      const raw: unknown = JSON.parse(
        await gh([
          'pr',
          'list',
          '--repo',
          repository,
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
      if (!Array.isArray(raw)) {
        throw new Error('invalid open pull request list');
      }
      return raw.map((entry): AppBootstrapOpenPullRequest => {
        if (
          !isRecord(entry) ||
          typeof entry.number !== 'number' ||
          typeof entry.isCrossRepository !== 'boolean' ||
          !isRecord(entry.headRepository) ||
          typeof entry.headRepository.name !== 'string' ||
          !isRecord(entry.headRepositoryOwner) ||
          typeof entry.headRepositoryOwner.login !== 'string'
        ) {
          throw new Error('invalid open pull request identity');
        }
        return {
          number: entry.number,
          crossRepository: entry.isCrossRepository,
          headOwner: entry.headRepositoryOwner.login,
          headRepository: entry.headRepository.name,
        };
      });
    },
    closePullRequest: async (repository, pullRequest) =>
      void (
        await gh([
          'pr',
          'close',
          String(pullRequest),
          '--repo',
          repository,
        ])
      ),
    currentBranch: async () =>
      (await git(['branch', '--show-current'])).trim() || null,
    detach: async (oid) => void (await git(['checkout', '--detach', oid])),
    deleteLocalBranch: async (branch, expectedOid) =>
      void (
        await git([
          'update-ref',
          '-d',
          `refs/heads/${branch}`,
          expectedOid,
        ])
      ),
    deleteRemoteBranch: async (branch, expectedOid) =>
      void (
        await git([
          'push',
          'origin',
          `--force-with-lease=refs/heads/${branch}:${expectedOid}`,
          `:refs/heads/${branch}`,
        ])
      ),
  };
}

export function createRealAppBootstrapConflicts(
  repoDir: string,
): AppBootstrapConflicts {
  return createAppBootstrapConflicts(
    createRealAppBootstrapConflictResources(repoDir),
  );
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
