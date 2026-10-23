// §28.3

import { run } from './appBootstrapCommand';
import { createAppGitRemote } from './appCommand';
import { bootstrapProtectedArgs, isApprovedGitRemote } from './appBootstrapGit';
import { createOriginConfigReader, soleOriginUrl } from './originUrl';
import { freshDisabledHooksDir } from './gitHardening';
import { isGitObjectId } from '../shared/appBootstrap';

export type RunAppGatePush = (branch: string) => Promise<void>;

export function createRealAppGatePush(repoDir: string): RunAppGatePush {
  return async (branch) => {
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
    await createAppGitRemote(repoDir, protectedArgs).fastForwardRef(url, oid, ref);
    await git(['update-ref', `refs/remotes/origin/${branch}`, oid], 'push: remote-tracking ref update failed');
  };
}
