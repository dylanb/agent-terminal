import { execFile } from 'node:child_process';
import { APP_STATE_DIRS } from './appStateDirs';
import {
  createAppGitRemote,
  parseAppGitObjectId,
  runAppCommand,
} from './appCommand';
import { numberFromGithubUrl } from '../shared/githubUrl';
import {
  sameAppBootstrapConflictTarget,
  type AppBootstrapConflictTarget,
} from '../shared/appBootstrap';
import { isRecord } from './yamlRecord';
import {
  matchesGitHubRepositoryUrl,
  resolveGitHubRepository,
  validGitHubRepositorySelector,
  type GitHubRepositoryIdentity,
  type ResolvedGitHubRepository,
} from './githubRepository';

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

export interface AppBootstrapGit {
  isCleanTree(): Promise<boolean>;
  resolveBaseBranch(): Promise<string | null>;
  createBranchFromBase(branch: string, base: string): Promise<string>;
  commitEmptyStart(message: string): Promise<string>;
  pushBranchUpstream(branch: string): Promise<void>;
}

export interface BootstrapBranchWiper {
  wipeConflictingBranch(branch: string): Promise<void>;
}

export interface BootstrapBranchRollback {
  rollbackCreatedBranch(branch: string): Promise<void>;
}

export interface AppBootstrapBranchRollback {
  rollbackCreatedBranch(branch: string, expectedOid: string): Promise<void>;
}

export interface AppBootstrapConflicts {
  inspect(branch: string): Promise<AppBootstrapConflictTarget>;
  wipe(target: AppBootstrapConflictTarget): Promise<void>;
}

export interface AppBootstrapConflictStore {
  inspect(branch: string): Promise<AppBootstrapConflictTarget>;
  deleteLocalBranch(branch: string, expectedOid: string): Promise<void>;
  deleteRemoteBranch(branch: string, expectedOid: string): Promise<void>;
  closePullRequest(
    repository: string,
    branch: string,
    pullRequest: number,
  ): Promise<void>;
}

export interface BootstrapGitHub {
  viewIssue(issue: number): Promise<BootstrapIssue | null>;
  assignIssueToSelf(issue: number): Promise<void>;
  setIssueLabel(issue: number, label: string, on: boolean): Promise<void>;
  createDraftPr(args: { base: string; head: string; title: string; body: string }): Promise<number | null>;
  setPrLabel(pr: number, label: string, on: boolean): Promise<void>;
}

const EXEC_TIMEOUT_MS = 60_000;

function runLegacy(
  file: 'git' | 'gh',
  args: string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd, timeout: EXEC_TIMEOUT_MS },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
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

function legacyTreeIsClean(porcelain: string): boolean {
  const isAppState = (path: string): boolean =>
    APP_STATE_PREFIXES.some((prefix) => path.startsWith(prefix));
  return porcelain
    .split('\n')
    .filter((line) => line.length > 0)
    .every((line) =>
      line.slice(3).split(' -> ').every(isAppState),
    );
}

export function createRealBootstrapGit(
  repoDir: string,
): BootstrapGit & BootstrapBranchWiper & BootstrapBranchRollback {
  const git = (args: string[]): Promise<string> =>
    runLegacy('git', args, repoDir);
  const bestEffortGit = async (args: string[]): Promise<void> => {
    try {
      await git(args);
    } catch {
      // §26.9.
    }
  };
  return {
    isCleanTree: async () =>
      legacyTreeIsClean(await git(['status', '--porcelain'])),
    resolveBaseBranch: async () => {
      try {
        const output = await runLegacy(
          'gh',
          [
            'repo',
            'view',
            '--json',
            'defaultBranchRef',
            '--jq',
            '.defaultBranchRef.name',
          ],
          repoDir,
        );
        return output.trim() || null;
      } catch {
        return null;
      }
    },
    branchExists: async (branch) => {
      if ((await git(['branch', '--list', branch])).trim().length > 0) {
        return true;
      }
      try {
        return (
          await git(['ls-remote', '--heads', 'origin', branch])
        ).trim().length > 0;
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
      if ((await git(['branch', '--list', branch])).trim().length > 0) {
        await git(['checkout', '--detach']);
        await git(['branch', '-D', branch]);
      }
      if (
        (
          await git(['ls-remote', '--heads', 'origin', branch])
        ).trim().length > 0
      ) {
        await git(['push', 'origin', '--delete', branch]);
      }
    },
    createBranchFromBase: async (branch, base) => {
      await git(['fetch', 'origin', base]);
      await git(['checkout', '-b', branch, 'FETCH_HEAD']);
    },
    commitEmptyStart: async (message) => {
      await git(['commit', '--allow-empty', '-m', message]);
    },
    pushBranchUpstream: async (branch) => {
      await git(['push', '-u', 'origin', branch]);
    },
  };
}

export function createRealAppBootstrapGit(
  repoDir: string,
  resolvedRepository?: ResolvedGitHubRepository,
): AppBootstrapGit & AppBootstrapBranchRollback {
  const git = (args: string[]): Promise<string> =>
    runAppCommand('git', args, repoDir);
  const remote = createAppGitRemote(repoDir);
  let repositoryPromise: Promise<ResolvedGitHubRepository> | undefined;
  const repository = (): Promise<ResolvedGitHubRepository> =>
    resolvedRepository !== undefined
      ? Promise.resolve(resolvedRepository)
      : (repositoryPromise ??= resolveGitHubRepository(repoDir));
  const localObjectId = async (branch: string): Promise<string | null> => {
    try {
      return parseAppGitObjectId(
        await git([
          'show-ref',
          '--verify',
          '--hash',
          `refs/heads/${branch}`,
        ]),
        'local branch',
      );
    } catch {
      return null;
    }
  };
  const remoteObjectId = async (branch: string): Promise<string | null> =>
    remote.readRef(
      (await repository()).pushUrl,
      `refs/heads/${branch}`,
    );
  const deleteExactBranch = async (
    branch: string,
    localOid: string | null,
    remoteOid: string | null,
  ): Promise<void> => {
    if (localOid !== null) {
      if ((await git(['branch', '--show-current'])).trim() === branch) {
        await git(['checkout', '--detach', localOid]);
      }
      await git([
        'update-ref',
        '-d',
        `refs/heads/${branch}`,
        localOid,
      ]);
    }
    if (remoteOid !== null) {
      await remote.deleteRef(
        (await repository()).pushUrl,
        `refs/heads/${branch}`,
        remoteOid,
      );
    }
  };
  return {
    isCleanTree: async () => treeIsClean(await git(['status', '--porcelain'])),
    resolveBaseBranch: async () => {
      try {
        return (await repository()).defaultBranch;
      } catch {
        return null;
      }
    },
    rollbackCreatedBranch: async (branch, expectedOid) => {
      const expected = parseAppGitObjectId(
        expectedOid,
        'created branch',
      );
      const local = await localObjectId(branch);
      const remote = await remoteObjectId(branch);
      if (local !== null && local !== expected) {
        throw new Error(`local branch ${branch} moved during bootstrap`);
      }
      if (remote !== null && remote !== expected) {
        throw new Error(`remote branch ${branch} moved during bootstrap`);
      }
      await deleteExactBranch(branch, local, remote);
    },
    createBranchFromBase: async (branch, base) => {
      const baseOid = await remote.fetchRef(
        (await repository()).fetchUrl,
        base,
      );
      await git(['checkout', '-b', branch, baseOid]);
      return parseAppGitObjectId(
        await git(['rev-parse', '--verify', 'HEAD']),
        'created branch',
      );
    },
    commitEmptyStart: async (message) => {
      const parent = parseAppGitObjectId(
        await git(['rev-parse', '--verify', 'HEAD']),
        'bootstrap parent',
      );
      const tree = parseAppGitObjectId(
        await git(['rev-parse', '--verify', 'HEAD^{tree}']),
        'bootstrap tree',
      );
      const commit = parseAppGitObjectId(
        await git(['commit-tree', tree, '-p', parent, '-m', message]),
        'bootstrap commit',
      );
      await git(['update-ref', 'HEAD', commit, parent]);
      return commit;
    },
    pushBranchUpstream: async (branch) => {
      const oid = await localObjectId(branch);
      if (oid === null) {
        throw new Error(`local branch ${branch} does not exist`);
      }
      await remote.createRef(
        (await repository()).pushUrl,
        oid,
        `refs/heads/${branch}`,
      );
      await git([
        'update-ref',
        `refs/remotes/origin/${branch}`,
        oid,
      ]);
      await git([
        'branch',
        '--set-upstream-to',
        `origin/${branch}`,
        branch,
      ]);
    },
  };
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
      pullRequests.some(
        (number) => !Number.isSafeInteger(number) || number <= 0,
      )
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
        throw new Error(`conflicting resources changed for branch ${target.branch}`);
      }

      if (target.localOid !== null) {
        await store.deleteLocalBranch(
          target.branch,
          target.localOid,
        );
      }
      if (target.remoteOid !== null) {
        await store.deleteRemoteBranch(
          target.branch,
          target.remoteOid,
        );
      }
      for (const pr of target.pullRequests) {
        await store.closePullRequest(
          target.repository,
          target.branch,
          pr,
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

function createRealAppBootstrapConflictStore(
  repoDir: string,
  repository: ResolvedGitHubRepository,
): AppBootstrapConflictStore {
  const git = (args: string[]): Promise<string> =>
    runAppCommand('git', args, repoDir);
  const remote = createAppGitRemote(repoDir);
  const gh = (args: string[]): Promise<string> =>
    runAppCommand('gh', args, repoDir);
  const expectedPullRequestHeads = new Map<string, string>();
  const pullRequestKey = (branch: string, pullRequest: number): string =>
    `${branch}\0${pullRequest}`;
  const localObjectId = async (branch: string): Promise<string | null> => {
    try {
      return parseAppGitObjectId(
        await git([
          'show-ref',
          '--verify',
          '--hash',
          `refs/heads/${branch}`,
        ]),
        'local branch',
      );
    } catch {
      return null;
    }
  };
  const remoteObjectId = async (branch: string): Promise<string | null> =>
    remote.readRef(
      repository.pushUrl,
      `refs/heads/${branch}`,
    );
  return {
    inspect: async (branch) => {
      expectedPullRequestHeads.clear();
      const raw: unknown = JSON.parse(
        await gh([
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
        ]),
      );
      if (!Array.isArray(raw)) {
        throw new Error('invalid open pull request list');
      }
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
          entry.headRepository.name.trim().toLowerCase() !==
            repository.name ||
          !matchesGitHubRepositoryUrl(
            entry.url,
            repository,
            'pull',
            entry.number,
          )
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
      return {
        repository: repository.selector,
        branch,
        localOid: await localObjectId(branch),
        remoteOid: await remoteObjectId(branch),
        pullRequests,
      };
    },
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
      const raw: unknown = JSON.parse(
        await gh([
          'pr',
          'view',
          String(pullRequest),
          '--repo',
          repository.selector,
          '--json',
          'number,url,state,headRefOid,isCrossRepository,headRefName,headRepository,headRepositoryOwner',
        ]),
      );
      if (
        !isRecord(raw) ||
        raw.number !== pullRequest ||
        typeof raw.url !== 'string' ||
        !matchesGitHubRepositoryUrl(
          raw.url,
          repository,
          'pull',
          pullRequest,
        ) ||
        typeof raw.state !== 'string' ||
        typeof raw.headRefOid !== 'string' ||
        parseAppGitObjectId(raw.headRefOid, 'pull request head') !==
          expectedHeadOid ||
        raw.isCrossRepository !== false ||
        raw.headRefName !== branch ||
        !isRecord(raw.headRepository) ||
        typeof raw.headRepository.name !== 'string' ||
        raw.headRepository.name.trim().toLowerCase() !==
          repository.name ||
        !isRecord(raw.headRepositoryOwner) ||
        typeof raw.headRepositoryOwner.login !== 'string' ||
        raw.headRepositoryOwner.login.trim().toLowerCase() !==
          repository.owner
      ) {
        throw new Error('pull request changed before close');
      }
      if (raw.state === 'CLOSED') return;
      if (raw.state !== 'OPEN') {
        throw new Error('pull request is not open');
      }
      await gh([
        'pr',
        'close',
        String(pullRequest),
        '--repo',
        repository.selector,
      ]);
    },
    deleteLocalBranch: async (branch, expectedOid) => {
      if ((await git(['branch', '--show-current'])).trim() === branch) {
        await git(['checkout', '--detach', expectedOid]);
      }
      await git([
          'update-ref',
          '-d',
          `refs/heads/${branch}`,
          expectedOid,
      ]);
    },
    deleteRemoteBranch: async (branch, expectedOid) =>
      remote.deleteRef(
        repository.pushUrl,
        `refs/heads/${branch}`,
        expectedOid,
      ),
  };
}

export function createRealAppBootstrapConflicts(
  repoDir: string,
  resolvedRepository?: ResolvedGitHubRepository,
): AppBootstrapConflicts {
  let conflicts: AppBootstrapConflicts | undefined;
  const resolve = async (): Promise<AppBootstrapConflicts> => {
    if (conflicts === undefined) {
      const repository =
        resolvedRepository ?? (await resolveGitHubRepository(repoDir));
      conflicts = createAppBootstrapConflicts(
        createRealAppBootstrapConflictStore(repoDir, repository),
      );
    }
    return conflicts;
  };
  return {
    inspect: async (branch) => (await resolve()).inspect(branch),
    wipe: async (target) => (await resolve()).wipe(target),
  };
}

export function createRealBootstrapGitHub(
  repoDir: string,
): BootstrapGitHub {
  const gh = (args: string[]): Promise<string> =>
    runLegacy('gh', args, repoDir);
  return {
    viewIssue: async (issue) => {
      try {
        const parsed: unknown = JSON.parse(
          await gh([
            'issue',
            'view',
            String(issue),
            '--json',
            'title,url',
          ]),
        );
        return isRecord(parsed) &&
          typeof parsed.title === 'string' &&
          typeof parsed.url === 'string'
          ? { title: parsed.title, url: parsed.url }
          : null;
      } catch {
        return null;
      }
    },
    assignIssueToSelf: async (issue) => {
      await gh([
        'issue',
        'edit',
        String(issue),
        '--add-assignee',
        '@me',
      ]);
    },
    setIssueLabel: async (issue, label, on) => {
      await gh([
        'issue',
        'edit',
        String(issue),
        on ? '--add-label' : '--remove-label',
        label,
      ]);
    },
    createDraftPr: async ({ base, head, title, body }) =>
      numberFromGithubUrl(
        await gh([
          'pr',
          'create',
          '--draft',
          '--base',
          base,
          '--head',
          head,
          '--title',
          title,
          '--body',
          body,
        ]),
      ),
    setPrLabel: async (pr, label, on) => {
      await gh([
        'pr',
        'edit',
        String(pr),
        on ? '--add-label' : '--remove-label',
        label,
      ]);
    },
  };
}

export function createRealAppBootstrapGitHub(
  repoDir: string,
  resolvedRepository?: GitHubRepositoryIdentity,
): BootstrapGitHub {
  let repositoryPromise: Promise<GitHubRepositoryIdentity> | undefined;
  const repository = (): Promise<GitHubRepositoryIdentity> =>
    resolvedRepository !== undefined
      ? Promise.resolve(resolvedRepository)
      : (repositoryPromise ??= resolveGitHubRepository(repoDir));
  const gh = (args: string[]): Promise<string> =>
    runAppCommand('gh', args, repoDir);
  return {
    viewIssue: async (issue) => {
      try {
        const identity = await repository();
        const parsed: unknown = JSON.parse(
          await gh([
            'issue',
            'view',
            String(issue),
            '--repo',
            identity.selector,
            '--json',
            'title,url',
          ]),
        );
        if (
          isRecord(parsed) &&
          typeof parsed.title === 'string' &&
          typeof parsed.url === 'string' &&
          matchesGitHubRepositoryUrl(
            parsed.url,
            identity,
            'issues',
            issue,
          )
        ) {
          return { title: parsed.title, url: parsed.url };
        }
        return null;
      } catch {
        return null;
      }
    },
    assignIssueToSelf: async (issue) => {
      const identity = await repository();
      await gh([
        'issue',
        'edit',
        String(issue),
        '--add-assignee',
        '@me',
        '--repo',
        identity.selector,
      ]);
    },
    setIssueLabel: async (issue, label, on) => {
      const identity = await repository();
      await gh([
        'issue',
        'edit',
        String(issue),
        on ? '--add-label' : '--remove-label',
        label,
        '--repo',
        identity.selector,
      ]);
    },
    createDraftPr: async ({ base, head, title, body }) => {
      const identity = await repository();
      const out = await gh([
        'pr',
        'create',
        '--draft',
        '--base',
        base,
        '--head',
        head,
        '--title',
        title,
        '--body',
        body,
        '--repo',
        identity.selector,
      ]);
      const number = numberFromGithubUrl(out);
      return number !== null &&
        matchesGitHubRepositoryUrl(out.trim(), identity, 'pull', number)
        ? number
        : null;
    },
    setPrLabel: async (pr, label, on) => {
      const identity = await repository();
      await gh([
        'pr',
        'edit',
        String(pr),
        on ? '--add-label' : '--remove-label',
        label,
        '--repo',
        identity.selector,
      ]);
    },
  };
}

export interface RealAppBootstrapPorts {
  git: AppBootstrapGit;
  github: BootstrapGitHub;
  conflicts: AppBootstrapConflicts;
  rollbackCreatedBranch(branch: string, expectedOid: string): Promise<void>;
}

export function createRealAppBootstrapPorts(
  repoDir: string,
): RealAppBootstrapPorts {
  let portsPromise: Promise<RealAppBootstrapPorts> | undefined;
  const ports = (): Promise<RealAppBootstrapPorts> =>
    (portsPromise ??= resolveGitHubRepository(repoDir).then((repository) => {
      const git = createRealAppBootstrapGit(repoDir, repository);
      return {
        git,
        github: createRealAppBootstrapGitHub(repoDir, repository),
        conflicts: createRealAppBootstrapConflicts(repoDir, repository),
        rollbackCreatedBranch: (branch, expectedOid) =>
          git.rollbackCreatedBranch(branch, expectedOid),
      };
    }));
  return {
    git: {
      isCleanTree: async () => (await ports()).git.isCleanTree(),
      resolveBaseBranch: async () => (await ports()).git.resolveBaseBranch(),
      createBranchFromBase: async (branch, base) =>
        (await ports()).git.createBranchFromBase(branch, base),
      commitEmptyStart: async (message) =>
        (await ports()).git.commitEmptyStart(message),
      pushBranchUpstream: async (branch) =>
        (await ports()).git.pushBranchUpstream(branch),
    },
    github: {
      viewIssue: async (issue) => (await ports()).github.viewIssue(issue),
      assignIssueToSelf: async (issue) =>
        (await ports()).github.assignIssueToSelf(issue),
      setIssueLabel: async (issue, label, on) =>
        (await ports()).github.setIssueLabel(issue, label, on),
      createDraftPr: async (args) =>
        (await ports()).github.createDraftPr(args),
      setPrLabel: async (pullRequest, label, on) =>
        (await ports()).github.setPrLabel(pullRequest, label, on),
    },
    conflicts: {
      inspect: async (branch) => (await ports()).conflicts.inspect(branch),
      wipe: async (target) => (await ports()).conflicts.wipe(target),
    },
    rollbackCreatedBranch: async (branch, expectedOid) =>
      (await ports()).rollbackCreatedBranch(branch, expectedOid),
  };
}
