// §28.3

import { CommandFailure, run } from './appBootstrapCommand';
import { createAppGitRemote, type AppGitRemote } from './appCommand';
import { bootstrapProtectedArgs, isApprovedGitRemote } from './appBootstrapGit';
import { createOriginConfigReader, soleRemoteUrl } from './originUrl';
import { freshDisabledHooksDir } from './gitHardening';
import { isGitObjectId } from '../shared/appBootstrap';

export type RunAppGatePush = (branch: string) => Promise<void>;

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
  const url = await soleRemoteUrl(
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

/** Where a run's own branch stands on GitHub against its local head: absent, at it, behind it (the remote commit is
 *  an ancestor of the local head, so a push only adds commits), or diverged from it (any other commit). */
export type AppGateBranchOnGitHub =
  | { kind: 'absent' }
  | { kind: 'at-head' }
  | { kind: 'behind'; remote: string; head: string }
  | { kind: 'diverged'; remote: string; head: string };

export type ReadAppGateBranchOnGitHub = (branch: string) => Promise<AppGateBranchOnGitHub>;

async function branchOnGitHub(t: PushTarget): Promise<AppGateBranchOnGitHub> {
  const remote = await t.remote.readRef(t.url, t.ref);
  if (remote === null) return { kind: 'absent' };
  if (remote === t.oid) return { kind: 'at-head' };
  return (await isAncestor(t, remote)) ? { kind: 'behind', remote, head: t.oid } : { kind: 'diverged', remote, head: t.oid };
}

/** Whether `remote` is in the local head's history. Exit 1 from either probe is the answer no: a commit this
 *  repository lacks, or one not in that history. */
async function isAncestor(t: PushTarget, remote: string): Promise<boolean> {
  const probes = [
    ['rev-parse', '--verify', '--quiet', '--end-of-options', `${remote}^{commit}`],
    ['merge-base', '--is-ancestor', '--end-of-options', remote, t.oid],
  ];
  for (const probe of probes) {
    try {
      await t.git(probe, 'push: ancestry check failed');
    } catch (e) {
      if (e instanceof CommandFailure && e.exitCode === 1) return false;
      throw e;
    }
  }
  return true;
}

export function createRealAppGateBranchOnGitHub(repoDir: string): ReadAppGateBranchOnGitHub {
  return async (branch) => branchOnGitHub(await pushTarget(repoDir, branch));
}
