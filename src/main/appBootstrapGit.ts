import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { treeIsClean } from './gitTreeState';
import { errMsg } from './errno';
import { run, CommandFailure } from './appBootstrapCommand';
import { createAppGitRemote, type AppGitRemote } from './appCommand';
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
  // repository-local configuration (notably url.*.insteadOf) cannot redirect a fetch, push or delete to
  // a remote the operator never named. The isolated dir carries the same neutralizing -c arguments as the
  // in-repo invocations, or inherited hooks and upload/receive-pack overrides would revive there.
  let remote: AppGitRemote;
  const remoteOp = async <T>(failure: string, op: (r: AppGitRemote) => Promise<T>): Promise<T> => {
    try {
      return await op(remote);
    } catch (e) {
      throw new CommandFailure(failure, e instanceof CommandFailure ? e.exitCode : undefined);
    }
  };
  // Read from configuration, not `git remote get-url`: the latter applies url.*.insteadOf rewriting, so it
  // reports one repository while the operation reaches another. Paired with the isolated git dir above,
  // a repository-local rewrite can neither be read here nor applied there.
  const originUrl = async (push: boolean): Promise<string> => {
    if (push) {
      try {
        const configured = (
          await git(['config', '--get', 'remote.origin.pushurl'], 'origin resolution failed')
        ).trim();
        if (configured.length > 0) return configured;
      } catch {
        // no separate push URL configured; fall back to the fetch URL, as git does
      }
    }
    return (
      await git(['config', '--get', 'remote.origin.url'], 'origin resolution failed')
    ).trim();
  };
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
    '-c',
    'remote.origin.uploadpack=git-upload-pack',
    '-c',
    'remote.origin.receivepack=git-receive-pack',
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
  const assertSafeOrigin = async (push: boolean): Promise<void> => {
    const urls = (
      await git(
        [
          'remote',
          'get-url',
          ...(push ? ['--push'] : []),
          '--all',
          'origin',
        ],
        'origin URL resolution failed',
      )
    )
      .split('\n')
      .map((url) => url.trim())
      .filter((url) => url.length > 0);
    if (urls.length === 0 || urls.some((url) => !isApprovedGitRemote(url))) {
      throw new Error('unsafe origin transport configuration');
    }
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
    if (checkout.kind === 'branch') {
      await git(['switch', '--', checkout.value], 'previous branch restoration failed');
      return;
    }
    await git(['checkout', '--detach', checkout.value], 'previous commit restoration failed');
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
    resolveBaseBranch: async () => {
      try {
        await assertSafeRepository();
        const out = await run(
          'gh',
          ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
          repoDir,
          'default branch resolution failed',
        );
        const name = out.trim();
        return name.length > 0 ? name : null;
      } catch {
        return null;
      }
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
      await assertSafeOrigin(false);
      const remoteOid = await remoteOp('remote branch probe failed', async (r) =>
        r.readRef(await originUrl(false), `refs/heads/${branch}`));
      return { localOid, remoteOid };
    },
    // The remote goes first: it is the outward-facing half and the only one a server can refuse, so a
    // stale lease aborts the wipe with nothing yet destroyed on either side (§27.10).
    deleteBranch: async (branch, state) => {
      await assertSafeRepository();
      const remoteOid = state.remoteOid;
      if (remoteOid !== null) {
        await assertSafeOrigin(true);
        await remoteOp('remote branch wipe failed', async (r) =>
          r.deleteRef(await originUrl(true), `refs/heads/${branch}`, remoteOid));
      }
      const localOid = state.localOid;
      if (localOid !== null) {
        const checkout = await currentCheckout();
        if (checkout.kind === 'branch' && checkout.value === branch) {
          await git(['checkout', '--detach', localOid], 'local branch wipe failed');
        }
        await git(
          ['update-ref', '-d', `refs/heads/${branch}`, localOid],
          'local branch wipe failed',
        );
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
        await assertSafeOrigin(false);
        await assertSafeOrigin(true);
        const remoteOid = await remoteOp('remote branch rollback failed', async (r) =>
          r.readRef(await originUrl(true), `refs/heads/${branch}`));
        if (remoteOid !== null) {
          if (remoteOwnership === 'ambiguous') {
            unresolvedRemote =
              'remote branch rollback refused: initial push ownership is ambiguous';
          } else if (remoteOid !== ownedOid) {
            unresolvedRemote =
              'remote branch rollback refused: branch changed after bootstrap creation';
          } else {
            await remoteOp('remote branch rollback failed', async (r) =>
              r.deleteRef(await originUrl(true), `refs/heads/${branch}`, ownedOid));
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
      created.delete(branch);
      pushed.delete(branch);
      if (activeCreatedBranch === branch) activeCreatedBranch = null;
      if (unresolvedRemote !== null) {
        throw new UnresolvedRemoteBootstrapBranchError(unresolvedRemote);
      }
    },
    createBranchFromBase: async (branch, base) => {
      await assertSafeRepository();
      await assertSafeOrigin(false);
      const restore = await currentCheckout();
      await git(
        ['check-ref-format', '--branch', base],
        'base branch validation failed',
      );
      // The isolated fetch deposits the base commit in this repo's shared object store and hands back its
      // id, so no temporary ref is written into the real repository and none needs cleaning up.
      const fetchedBase = await remoteOp('base fetch failed', async (r) =>
        r.fetchRef(await originUrl(false), `refs/heads/${base}`));
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
        if (!/^[0-9a-f]{40,64}$/.test(oid)) {
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
      await assertSafeOrigin(true);
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
          r.createRef(await originUrl(true), ownedOid, `refs/heads/${branch}`));
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
      await git(
        ['branch', `--set-upstream-to=origin/${branch}`, branch],
        'branch upstream configuration failed',
      );
      return ownedOid;
    },
  };
}

