// §28.3

import { run } from './appBootstrapCommand';
import { createAppGitRemote, type AppGitRemote } from './appCommand';
import { bootstrapProtectedArgs, isApprovedGitRemote } from './appBootstrapGit';
import { createOriginConfigReader, soleOriginUrl } from './originUrl';
import { freshDisabledHooksDir } from './gitHardening';
import { isGitObjectId } from '../shared/appBootstrap';

export type RunAppGatePush = (branch: string) => Promise<void>;

/** Publishes a run's own branch to origin without ever overwriting a remote commit: an absent branch is created,
 *  one already at the local head is left as it is, and one at any other commit is refused. */
export type RunAppGateBranchCreate = (branch: string) => Promise<void>;

interface PushTarget {
  remote: AppGitRemote;
  url: string;
  ref: string;
  oid: string;
  git(args: string[], failure: string): Promise<string>;
}

async function pushTarget(repoDir: string, branch: string): Promise<PushTarget> {
  const protectedArgs = bootstrapProtectedArgs(freshDisabledHooksDir());
  const git = (args: string[], failure: string): Promise<string> =>
    run('git', [...protectedArgs, ...args], repoDir, failure);
  const url = await soleOriginUrl(
    createOriginConfigReader((args) => git(args, 'origin resolution failed')),
    'push',
  );
  if (url === null || !isApprovedGitRemote(url)) {
    throw new Error('unsafe origin transport configuration');
  }
  const ref = `refs/heads/${branch}`;
  const oid = (
    await git(['rev-parse', '--verify', '--end-of-options', ref], `push: no local branch ${branch}`)
  ).trim();
  if (!isGitObjectId(oid)) throw new Error(`push: ${branch} does not resolve to a commit`);
  return { remote: createAppGitRemote(repoDir, protectedArgs), url, ref, oid, git };
}

const trackRemote = (t: PushTarget, branch: string): Promise<string> =>
  t.git(['update-ref', `refs/remotes/origin/${branch}`, t.oid], 'push: remote-tracking ref update failed');

export function createRealAppGatePush(repoDir: string): RunAppGatePush {
  return async (branch) => {
    const t = await pushTarget(repoDir, branch);
    await t.remote.fastForwardRef(t.url, t.oid, t.ref);
    await trackRemote(t, branch);
  };
}

export function createRealAppGateBranchCreate(repoDir: string): RunAppGateBranchCreate {
  return async (branch) => {
    const t = await pushTarget(repoDir, branch);
    const remote = await t.remote.readRef(t.url, t.ref);
    if (remote === null) await t.remote.createRef(t.url, t.oid, t.ref);
    else if (remote !== t.oid) {
      throw new Error(
        `the branch ${branch} is already on GitHub at ${remote}, not at this run's ${t.oid}; nothing was pushed or overwritten. Remove that branch from GitHub if it is not this run's, then approve again, or terminate the run`,
      );
    }
    await trackRemote(t, branch);
  };
}
