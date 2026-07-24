import { APP_STATE_DIRS } from './appStateDirs';
import {
  createAppGitRemote,
  parseAppGitObjectId,
  runAppCommand,
} from './appCommand';
import type { GitHubRepositorySource } from './githubRepository';
import type {
  AppBootstrapGit,
  AppBootstrapPorts,
} from './appLoopBootstrap';

const APP_STATE_PREFIXES = APP_STATE_DIRS.map((dir) => `${dir}/`);

function treeIsClean(porcelain: string): boolean {
  const isAppState = (path: string): boolean =>
    APP_STATE_PREFIXES.some((prefix) => path.startsWith(prefix));
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

export function createRealAppBootstrapGit(
  repoDir: string,
  repositorySource: GitHubRepositorySource,
): AppBootstrapGit & Pick<AppBootstrapPorts, 'rollbackCreatedBranch'> {
  const git = (args: string[]): Promise<string> =>
    runAppCommand('git', args, repoDir);
  const remote = createAppGitRemote(repoDir);
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
      (await repositorySource.resolve()).pushUrl,
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
        (await repositorySource.resolve()).pushUrl,
        `refs/heads/${branch}`,
        remoteOid,
      );
    }
  };
  return {
    isCleanTree: async () => treeIsClean(await git(['status', '--porcelain'])),
    resolveBaseBranch: async () => {
      try {
        return (await repositorySource.resolve()).defaultBranch;
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
      const remoteOid = await remoteObjectId(branch);
      if (local !== null && local !== expected) {
        throw new Error(`local branch ${branch} moved during bootstrap`);
      }
      if (remoteOid !== null && remoteOid !== expected) {
        throw new Error(`remote branch ${branch} moved during bootstrap`);
      }
      await deleteExactBranch(branch, local, remoteOid);
    },
    createBranchFromBase: async (branch, base) => {
      const baseOid = await remote.fetchRef(
        (await repositorySource.resolve()).fetchUrl,
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
        (await repositorySource.resolve()).pushUrl,
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
