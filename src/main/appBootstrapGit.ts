import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { treeIsClean } from './gitTreeState';
import { errMsg } from './errno';
import { run, CommandFailure } from './appBootstrapCommand';
import { createAppGitRemote, type AppGitRemote } from './appCommand';
import {
  createOriginConfigReader,
  soleOriginUrl,
  type OriginDirection,
} from './originUrl';
import { isGitObjectId } from '../shared/appBootstrap';
import {
  createGitHubRepositorySource,
  type GitHubRepositorySource,
} from './githubRepository';
import {
  OwnedBootstrapBranchError,
  UnresolvedRemoteBootstrapBranchError,
  type AppBootstrapGit,
  type AppBootstrapGitFaults,
} from './bootstrapPorts';

function isUnsafeLocalGitConfigKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === 'core.askpass' ||
    normalized === 'core.fsmonitor' ||
    normalized === 'core.gitproxy' ||
    normalized === 'core.hookspath' ||
    normalized === 'core.sshcommand' ||
    normalized === 'core.worktree' ||
    /^credential(?:\..+)?\.helper$/.test(normalized) ||
    /^filter\..+\.(?:clean|process|smudge)$/.test(normalized) ||
    /^protocol\..+\.allow$/.test(normalized) ||
    /^remote\..+\.(?:receivepack|uploadpack|vcs)$/.test(normalized)
  );
}

function isApprovedGitRemote(url: string): boolean {
  if (/[\0-\x1f\x7f]/.test(url)) return false;
  if (/^(?:https|ssh):\/\/\S+$/i.test(url)) return true;
  if (/^(?:[^@:/\s]+@)?[^:/\s]+:[^\r\n]+$/.test(url)) return true;
  if (/^(?:file:\/\/|\/|\.{1,2}\/)/i.test(url)) return true;
  return /^[a-z]:[\\/]/i.test(url);
}

export function createRealAppBootstrapGit(
  repoDir: string,
  faults: AppBootstrapGitFaults = {},
  repositorySource: GitHubRepositorySource = createGitHubRepositorySource(repoDir),
): AppBootstrapGit {
  type Checkout = { kind: 'branch'; value: string } | { kind: 'detached'; value: string };
  interface CreatedBranch {
    restore: Checkout;
    expectedLocalOid: string;
    startMessage?: string;
  }
  const created = new Map<string, CreatedBranch>();
  const pushed = new Map<string, 'confirmed' | 'ambiguous'>();
  let activeCreatedBranch: string | null = null;
  const expectedRepoRoot = realpathSync(repoDir);
  // Every remote operation runs in a throwaway bare git dir sharing only this repo's object store, so
  // repository-local configuration cannot redirect a fetch, push or delete to a remote the operator
  // never named. The isolated dir carries the same neutralizing -c arguments as the in-repo
  // invocations, or inherited hooks would revive there; the pack programs are pinned on the argv
  // instead, since these operations address the remote by URL and remote.origin.* would not bind.
  let remote: AppGitRemote;
  const remoteOp = async <T>(failure: string, op: (r: AppGitRemote) => Promise<T>): Promise<T> => {
    try {
      return await op(remote);
    } catch (e) {
      throw new CommandFailure(
        `${failure}: ${errMsg(e)}`,
        e instanceof CommandFailure ? e.exitCode : undefined,
      );
    }
  };
  const originConfig = createOriginConfigReader((args) =>
    git(args, 'origin resolution failed'),
  );
  const disabledHooksPath = join(
    tmpdir(),
    `agent-terminal-disabled-hooks-${randomUUID()}`,
  );
  const protectedArgs = [
    '-c',
    `core.hooksPath=${disabledHooksPath}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.sshCommand=ssh',
    '-c',
    'credential.interactive=false',
    '-c',
    'protocol.allow=never',
    '-c',
    'protocol.ext.allow=never',
    '-c',
    'protocol.file.allow=always',
    '-c',
    'protocol.https.allow=always',
    '-c',
    'protocol.ssh.allow=always',
  ];
  const git = (args: string[], failure: string): Promise<string> =>
    run('git', [...protectedArgs, ...args], repoDir, failure);
  remote = createAppGitRemote(repoDir, protectedArgs);
  const assertSafeLocalConfig = async (): Promise<void> => {
    const keys = await git(
      ['config', '--local', '--name-only', '--null', '--list'],
      'repository-local Git configuration check failed',
    );
    if (keys.split('\0').some(isUnsafeLocalGitConfigKey)) {
      throw new Error('unsafe repository-local Git configuration');
    }
  };
  const assertSafeRepository = async (): Promise<void> => {
    await assertSafeLocalConfig();
    const topLevel = (
      await git(
        ['rev-parse', '--show-toplevel'],
        'repository identity resolution failed',
      )
    ).trim();
    let resolvedTopLevel: string;
    try {
      resolvedTopLevel = realpathSync(topLevel);
    } catch {
      throw new Error('repository identity mismatch');
    }
    if (resolvedTopLevel !== expectedRepoRoot) {
      throw new Error('repository identity mismatch');
    }
  };
  // One read, graded and used: a check over its own read of config leaves a window in which the value
  // the operation reaches is not the value the allow-list approved.
  // TODO(dylanb): the destination is still config at operation time rather than the pushUrl/fetchUrl
  // resolveGitHubRepository already validated against the pinned identity. Binding it there would make
  // every fetch/push/ref-delete — including the offline rollback path — require a live `gh repo view`,
  // and would refuse the non-GitHub remotes the port supports today. That is a design decision, not a
  // local fix: it narrows this port to GitHub-only.
  const approvedOriginUrl = async (
    direction: OriginDirection,
  ): Promise<string> => {
    const url = await soleOriginUrl(originConfig, direction);
    if (url === null || !isApprovedGitRemote(url)) {
      throw new Error('unsafe origin transport configuration');
    }
    return url;
  };
  const currentCheckout = async (): Promise<Checkout> => {
    const injectedFailure = faults.currentCheckoutResult?.();
    if (injectedFailure) throw injectedFailure;
    try {
      const branch = (await git(
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        'current branch resolution failed',
      )).trim();
      if (branch.length > 0) return { kind: 'branch', value: branch };
    } catch (e) {
      if (!(e instanceof CommandFailure && e.exitCode === 1)) throw e;
    }
    const oid = (await git(['rev-parse', 'HEAD'], 'current commit resolution failed')).trim();
    return { kind: 'detached', value: oid };
  };
  const restoreCheckout = async (checkout: Checkout): Promise<void> => {
    const injectedFailure = faults.restoreCheckoutResult?.();
    if (injectedFailure) throw injectedFailure;
    if (checkout.kind === 'branch') {
      await git(['switch', '--', checkout.value], 'previous branch restoration failed');
      return;
    }
    await git(['checkout', '--detach', checkout.value], 'previous commit restoration failed');
  };
  // A delete-push to a NAMED remote drops refs/remotes/<remote>/<branch>, and `git branch -D` drops the
  // branch.<name> section; deleting through the URL-addressed isolated dir does neither, so both caches
  // outlive the branch. Keyed on the RESOURCE, not on which leg ran: every route that removes the branch
  // leaves neither behind. Cleanup only — it must never fail a step whose destructive half already landed.
  const forgetBranchCaches = async (branch: string): Promise<void> => {
    for (const args of [
      ['update-ref', '-d', `refs/remotes/origin/${branch}`],
      ['config', '--remove-section', `branch.${branch}`],
    ]) {
      try {
        await git(args, 'branch cache cleanup failed');
      } catch {
        /* best-effort */
      }
    }
  };
  const reconcileStartCommit = async (
    branch: string,
    state: CreatedBranch,
  ): Promise<string | null> => {
    if (state.startMessage === undefined) return null;
    const oid = (await git(
      ['rev-parse', '--verify', `refs/heads/${branch}`],
      'start commit reconciliation failed',
    )).trim();
    const parent = (await git(
      ['rev-parse', `${oid}^`],
      'start commit reconciliation failed',
    )).trim();
    const subject = (await git(
      ['log', '-1', '--format=%B', oid],
      'start commit reconciliation failed',
    )).trim();
    const changed = await git(
      ['diff-tree', '--no-commit-id', '--name-only', '-r', oid],
      'start commit reconciliation failed',
    );
    if (
      parent !== state.expectedLocalOid ||
      subject !== state.startMessage ||
      changed.trim().length > 0
    ) {
      return null;
    }
    state.expectedLocalOid = oid;
    return oid;
  };
  return {
    isCleanTree: async () => {
      await assertSafeRepository();
      if (!treeIsClean(await git(['status', '--porcelain'], 'working tree check failed'))) {
        return false;
      }
      try {
        await git(['diff', '--cached', '--quiet', '--'], 'staged change check failed');
        return true;
      } catch {
        return false;
      }
    },
    // The reason a base cannot be resolved (unauthenticated gh, an origin that does not match GitHub)
    // reaches the operator through the caller's error path; collapsing it to null reported every one of
    // them as "could not resolve base branch".
    resolveBaseBranch: async () => {
      await assertSafeRepository();
      return (await repositorySource.resolve()).defaultBranch;
    },
    branchState: async (branch) => {
      await assertSafeRepository();
      let localOid: string | null;
      try {
        await git(
          ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
          'local branch probe failed',
        );
        localOid = (
          await git(
            ['rev-parse', '--verify', `refs/heads/${branch}`],
            'local branch probe failed',
          )
        ).trim();
      } catch (e) {
        if (e instanceof CommandFailure && e.exitCode === 1) localOid = null;
        else throw e;
      }
      const probeUrl = await approvedOriginUrl('fetch');
      const remoteOid = await remoteOp('remote branch probe failed', async (r) =>
        r.readRef(probeUrl, `refs/heads/${branch}`));
      return { localOid, remoteOid };
    },
    deleteBranch: async (branch, state) => {
      await assertSafeRepository();
      const localOid = state.localOid;
      if (localOid !== null) {
        const current = (
          await git(
            ['rev-parse', '--verify', `refs/heads/${branch}`],
            'local branch wipe failed',
          )
        ).trim();
        if (current !== localOid) {
          throw new Error(
            'local branch wipe failed: branch changed after the caller read its identity',
          );
        }
      }
      const remoteOid = state.remoteOid;
      if (remoteOid !== null) {
        const wipeUrl = await approvedOriginUrl('push');
        await remoteOp('remote branch wipe failed', async (r) =>
          r.deleteRef(wipeUrl, `refs/heads/${branch}`, remoteOid));
        await forgetBranchCaches(branch);
      }
      if (localOid !== null) {
        const checkout = await currentCheckout();
        const movedHead = checkout.kind === 'branch' && checkout.value === branch;
        if (movedHead) {
          await git(['checkout', '--detach', localOid], 'local branch wipe failed');
        }
        try {
          // The porcelain delete: only `git branch -D` knows git's full "branch is in use" rule —
          // mid-rebase a worktree reports `detached` with no branch line and `for-each-ref
          // %(worktreepath)` is empty, so no plumbing query expresses it. Its output is NOT parsed:
          // git translates "Deleted branch %s (was %s)." through gettext, so a locale would decide
          // whether the wipe worked. The lease is the rev-parse check immediately above.
          await git(['branch', '-D', '--', branch], 'local branch wipe failed');
        } catch (e) {
          if (!movedHead) throw e;
          try {
            await restoreCheckout(checkout);
          } catch {
            throw new Error(
              'local branch wipe failed: HEAD is detached and the previous checkout could not be restored',
            );
          }
          throw e;
        }
        await forgetBranchCaches(branch);
      }
    },
    rollbackCreatedBranch: async (branch, ownedOid) => {
      await assertSafeRepository();
      const state = created.get(branch);
      if (state === undefined) throw new Error('local branch rollback refused: bootstrap ownership is unknown');
      let expectedLocalOid = ownedOid ?? state.expectedLocalOid;
      if (ownedOid !== null && state.expectedLocalOid !== ownedOid) {
        throw new Error('local branch rollback refused: bootstrap ownership changed');
      }
      let local: string | null;
      try {
        await git(
          ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
          'local branch rollback probe failed',
        );
        local = await git(
          ['rev-parse', '--verify', `refs/heads/${branch}`],
          'local branch rollback failed',
        );
      } catch (e) {
        if (e instanceof CommandFailure && e.exitCode === 1) local = null;
        else throw e;
      }
      if (local !== null && local.trim() !== expectedLocalOid && ownedOid === null) {
        const reconciled = await reconcileStartCommit(branch, state);
        if (reconciled !== null) {
          expectedLocalOid = reconciled;
          local = reconciled;
        }
      }
      const localChanged = local !== null && local.trim() !== expectedLocalOid;
      const remoteOwnership = pushed.get(branch);
      let unresolvedRemote: string | null = null;
      if (ownedOid !== null && remoteOwnership !== undefined) {
        const rollbackUrl = await approvedOriginUrl('push');
        const remoteOid = await remoteOp('remote branch rollback failed', async (r) =>
          r.readRef(rollbackUrl, `refs/heads/${branch}`));
        if (remoteOid !== null) {
          if (remoteOwnership === 'ambiguous') {
            unresolvedRemote =
              'remote branch rollback refused: initial push ownership is ambiguous';
          } else if (remoteOid !== ownedOid) {
            unresolvedRemote =
              'remote branch rollback refused: branch changed after bootstrap creation';
          } else {
            await remoteOp('remote branch rollback failed', async (r) =>
              r.deleteRef(rollbackUrl, `refs/heads/${branch}`, ownedOid));
          }
        }
      }
      const checkout = await currentCheckout();
      if (
        (checkout.kind === 'branch' && checkout.value === branch) ||
        (checkout.kind === 'detached' && checkout.value === expectedLocalOid)
      ) {
        await restoreCheckout(state.restore);
      }
      if (localChanged) {
        throw new Error('local branch rollback refused: branch changed after bootstrap creation');
      }
      if (local !== null) {
        await git(
          ['update-ref', '-d', `refs/heads/${branch}`, expectedLocalOid],
          'local branch rollback failed',
        );
      }
      await forgetBranchCaches(branch);
      created.delete(branch);
      pushed.delete(branch);
      if (activeCreatedBranch === branch) activeCreatedBranch = null;
      if (unresolvedRemote !== null) {
        throw new UnresolvedRemoteBootstrapBranchError(unresolvedRemote);
      }
    },
    createBranchFromBase: async (branch, base) => {
      await assertSafeRepository();
      const baseUrl = await approvedOriginUrl('fetch');
      const restore = await currentCheckout();
      await git(
        ['check-ref-format', '--branch', base],
        'base branch validation failed',
      );
      // The isolated fetch deposits the base commit in this repo's shared object store and hands back its
      // id, so no temporary ref is written into the real repository and none needs cleaning up.
      const fetchedBase = await remoteOp('base fetch failed', async (r) =>
        r.fetchRef(baseUrl, `refs/heads/${base}`));
      const baseOid = (await git(
        ['rev-parse', '--verify', `${fetchedBase}^{commit}`],
        'base commit resolution failed',
      )).trim();
      const ownershipMarker = `agent-terminal-bootstrap:${randomUUID()}`;
      let creationError: unknown = null;
      try {
        await git(
          [
            'update-ref',
            '--create-reflog',
            '-m',
            ownershipMarker,
            `refs/heads/${branch}`,
            baseOid,
            '0'.repeat(baseOid.length),
          ],
          'branch creation failed',
        );
        const injectedFailure = faults.branchCreationResult?.();
        if (injectedFailure) throw injectedFailure;
      } catch (e) {
        creationError = e;
        let owned = false;
        try {
          const landedOid = (await git(
            ['rev-parse', '--verify', `refs/heads/${branch}`],
            'branch creation reconciliation failed',
          )).trim();
          const landedMarker = (await git(
            ['reflog', 'show', '-1', '--format=%gs', `refs/heads/${branch}`],
            'branch creation reconciliation failed',
          )).trim();
          owned = landedOid === baseOid && landedMarker === ownershipMarker;
        } catch {}
        if (!owned) throw e;
      }
      created.set(branch, { restore, expectedLocalOid: baseOid });
      activeCreatedBranch = branch;
      if (creationError !== null) {
        throw new OwnedBootstrapBranchError(errMsg(creationError));
      }
      try {
        await git(['checkout', branch], 'branch checkout failed');
        const injectedFailure = faults.checkoutResult?.();
        if (injectedFailure) throw injectedFailure;
      } catch (e) {
        throw new OwnedBootstrapBranchError(errMsg(e));
      }
    },
    commitEmptyStart: async (message) => {
      await assertSafeRepository();
      const activeBranch = activeCreatedBranch;
      const state = activeBranch === null ? undefined : created.get(activeBranch);
      if (activeBranch === null || state === undefined) {
        throw new Error('start commit refused: bootstrap branch ownership is unknown');
      }
      state.startMessage = message.trim();
      let oid: string;
      try {
        const tree = (await git(
          ['rev-parse', `${state.expectedLocalOid}^{tree}`],
          'start commit tree resolution failed',
        )).trim();
        oid = (await git(
          ['commit-tree', tree, '-p', state.expectedLocalOid, '-m', message],
          'start commit creation failed',
        )).trim();
        if (!isGitObjectId(oid)) {
          throw new Error('start commit creation returned an invalid object id');
        }
        await git(
          [
            'update-ref',
            `refs/heads/${activeBranch}`,
            oid,
            state.expectedLocalOid,
          ],
          'start commit ref update failed',
        );
        const injectedFailure = faults.startCommitResult?.();
        if (injectedFailure) throw injectedFailure;
      } catch (e) {
        try {
          await reconcileStartCommit(activeBranch, state);
        } catch {}
        throw e;
      }
      try {
        const changed = await git(
          ['diff-tree', '--no-commit-id', '--name-only', '-r', oid],
          'start commit verification failed',
        );
        if (changed.trim().length > 0) {
          throw new Error('start commit refused: staged changes were included');
        }
        state.expectedLocalOid = oid;
        return oid;
      } catch (e) {
        try {
          await reconcileStartCommit(activeBranch, state);
        } catch {}
        throw e;
      }
    },
    pushBranchUpstream: async (branch, ownedOid) => {
      await assertSafeRepository();
      const pushUrl = await approvedOriginUrl('push');
      const state = created.get(branch);
      if (state === undefined || state.expectedLocalOid !== ownedOid) {
        throw new Error('branch push refused: bootstrap ownership changed');
      }
      const localOid = (await git(
        ['rev-parse', '--verify', `refs/heads/${branch}`],
        'branch commit resolution failed',
      )).trim();
      if (localOid !== ownedOid) {
        throw new Error('branch push refused: branch changed after bootstrap commit');
      }
      try {
        await remoteOp('branch push failed', async (r) =>
          r.createRef(pushUrl, ownedOid, `refs/heads/${branch}`));
        const injectedFailure = faults.pushResult?.();
        if (injectedFailure) throw injectedFailure;
        pushed.set(branch, 'confirmed');
      } catch (e) {
        pushed.set(branch, 'ambiguous');
        throw e;
      }
      const afterPushOid = (await git(
        ['rev-parse', '--verify', `refs/heads/${branch}`],
        'post-push branch verification failed',
      )).trim();
      if (afterPushOid !== ownedOid) {
        throw new Error('branch push completed after the local branch changed');
      }
      // The isolated push leaves no remote-tracking ref behind, so record the one `git push -u` would have
      // written before asking git to track it.
      await git(
        ['update-ref', `refs/remotes/origin/${branch}`, ownedOid],
        'branch upstream configuration failed',
      );
      // The pair `git push -u` writes, set directly: `--set-upstream-to` resolves origin/<branch>
      // through the remote's FETCH REFSPEC, so on a single-branch clone it refuses outright.
      await git(
        ['config', `branch.${branch}.remote`, 'origin'],
        'branch upstream configuration failed',
      );
      await git(
        ['config', `branch.${branch}.merge`, `refs/heads/${branch}`],
        'branch upstream configuration failed',
      );
      return ownedOid;
    },
  };
}
