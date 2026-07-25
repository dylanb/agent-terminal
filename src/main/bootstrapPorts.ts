import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { APP_STATE_DIRS } from './appStateDirs';
import { errMsg } from './errno';
import { numberFromGithubUrl } from '../shared/githubUrl';

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
  branchExists(branch: string): Promise<boolean>;
  createBranchFromBase(branch: string, base: string): Promise<void>;
  commitEmptyStart(message: string): Promise<string>;
  pushBranchUpstream(branch: string, ownedOid: string): Promise<string>;
  rollbackCreatedBranch(branch: string, ownedOid: string | null): Promise<void>;
}

export interface AppBootstrapGitFaults {
  currentCheckoutResult?: () => Error | null;
  branchCreationResult?: () => Error | null;
  checkoutResult?: () => Error | null;
  startCommitResult?: () => Error | null;
  pushResult?: () => Error | null;
}

export type OwnedPrLookup =
  | { kind: 'owned'; number: number }
  | { kind: 'absent' }
  | { kind: 'foreign' };

export interface BootstrapBranchWiper {
  wipeConflictingBranch(branch: string): Promise<void>;
}

export interface BootstrapGitHub {
  viewIssue(issue: number): Promise<BootstrapIssue | null>;
  assignIssueToSelf(issue: number): Promise<void>;
  setIssueLabel(issue: number, label: string, on: boolean): Promise<void>;
  createDraftPr(args: { base: string; head: string; title: string; body: string }): Promise<number | null>;
  setPrLabel(pr: number, label: string, on: boolean): Promise<void>;
}

export interface AppBootstrapGitHub {
  viewIssue(issue: number): Promise<BootstrapIssue | null>;
  assignIssueToSelf(issue: number): Promise<void>;
  setIssueLabel(issue: number, label: string, on: boolean): Promise<void>;
  createDraftPr(args: { base: string; head: string; title: string; body: string }): Promise<number>;
  findOwnedOpenPr(args: { base: string; head: string; marker: string }): Promise<OwnedPrLookup>;
  closePr(pr: number): Promise<void>;
  setPrLabel(pr: number, label: string, on: boolean): Promise<void>;
}

export class AmbiguousBootstrapOperationError extends Error {}
export class OwnedBootstrapBranchError extends Error {}
export class UnresolvedRemoteBootstrapBranchError extends Error {}

const EXEC_TIMEOUT_MS = 60_000;

class CommandFailure extends Error {
  constructor(message: string, readonly exitCode: string | number | undefined) {
    super(message);
  }
}

function run(file: string, args: string[], cwd: string, failure: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        const commandError = err as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: NodeJS.Signals | null;
        };
        const code =
          typeof commandError.code === 'number'
            ? ` (exit ${commandError.code})`
            : '';
        reject(new CommandFailure(`${failure}${code}`, commandError.code));
      } else resolve(stdout);
    });
  });
}

function runLegacy(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
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
): AppBootstrapGit & BootstrapBranchWiper {
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
  const bestEffortGit = async (args: string[], failure: string): Promise<void> => {
    try {
      await git(args, failure);
    } catch {
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
    branchExists: async (branch) => {
      await assertSafeRepository();
      const local = await git(['branch', '--list', branch], 'local branch probe failed');
      if (local.trim().length > 0) return true;
      await assertSafeOrigin(false);
      const remote = await git(
        [
          'ls-remote',
          '--upload-pack=git-upload-pack',
          '--heads',
          'origin',
          branch,
        ],
        'remote branch probe failed',
      );
      return remote.trim().length > 0;
    },
    wipeConflictingBranch: async (branch) => {
      await assertSafeRepository();
      await assertSafeOrigin(true);
      await bestEffortGit(['checkout', '--detach'], 'branch detach failed');
      await bestEffortGit(['branch', '-D', branch], 'local branch wipe failed');
      await bestEffortGit(
        ['push', '--receive-pack=git-receive-pack', 'origin', '--delete', branch],
        'remote branch wipe failed',
      );
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
        const remote = (await git(
          [
            'ls-remote',
            '--upload-pack=git-upload-pack',
            '--heads',
            'origin',
            branch,
          ],
          'remote branch rollback failed',
        )).trim();
        if (remote.length > 0) {
          const remoteOid = remote.split(/\s+/, 1)[0];
          if (remoteOwnership === 'ambiguous') {
            unresolvedRemote =
              'remote branch rollback refused: initial push ownership is ambiguous';
          } else if (remoteOid !== ownedOid) {
            unresolvedRemote =
              'remote branch rollback refused: branch changed after bootstrap creation';
          } else {
            await git(
              [
                'push',
                '--receive-pack=git-receive-pack',
                `--force-with-lease=refs/heads/${branch}:${ownedOid}`,
                'origin',
                `:refs/heads/${branch}`,
              ],
              'remote branch rollback failed',
            );
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
      const fetchedRef = `refs/agent-terminal/bootstrap/${randomUUID()}`;
      let baseOid: string | null = null;
      try {
        await git(
          [
            'fetch',
            '--upload-pack=git-upload-pack',
            '--no-tags',
            '--no-write-fetch-head',
            'origin',
            `refs/heads/${base}:${fetchedRef}`,
          ],
          'base fetch failed',
        );
        baseOid = (await git(
          ['rev-parse', '--verify', `${fetchedRef}^{commit}`],
          'base commit resolution failed',
        )).trim();
        await git(
          ['update-ref', '-d', fetchedRef, baseOid],
          'base ref cleanup failed',
        );
      } catch (e) {
        await bestEffortGit(
          baseOid === null
            ? ['update-ref', '-d', fetchedRef]
            : ['update-ref', '-d', fetchedRef, baseOid],
          'base ref cleanup failed',
        );
        throw e;
      }
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
        await git(
          [
            'push',
            '--receive-pack=git-receive-pack',
            `--force-with-lease=refs/heads/${branch}:`,
            'origin',
            `${ownedOid}:refs/heads/${branch}`,
          ],
          'branch push failed',
        );
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
      await git(
        ['branch', `--set-upstream-to=origin/${branch}`, branch],
        'branch upstream configuration failed',
      );
      return ownedOid;
    },
  };
}

export function createRealBootstrapGit(repoDir: string): BootstrapGit & BootstrapBranchWiper {
  const git = (args: string[]): Promise<string> => runLegacy('git', args, repoDir);
  const bestEffortGit = async (args: string[]): Promise<void> => {
    try {
      await git(args);
    } catch {}
  };
  return {
    isCleanTree: async () => treeIsClean(await git(['status', '--porcelain'])),
    resolveBaseBranch: async () => {
      try {
        const out = await runLegacy(
          'gh',
          ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
          repoDir,
        );
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
        const remote = await runLegacy(
          'git',
          ['ls-remote', '--heads', 'origin', branch],
          repoDir,
        );
        return remote.trim().length > 0;
      } catch {
        return false;
      }
    },
    createBranchFromBase: async (branch, base) => {
      await git(['fetch', 'origin', base]);
      await git(['checkout', '-b', branch, 'FETCH_HEAD']);
    },
    commitEmptyStart: async (message) =>
      void (await git(['commit', '--allow-empty', '-m', message])),
    pushBranchUpstream: async (branch) =>
      void (await git(['push', '-u', 'origin', branch])),
    wipeConflictingBranch: async (branch) => {
      await bestEffortGit(['checkout', '--detach']);
      await bestEffortGit(['branch', '-D', branch]);
      await bestEffortGit(['push', 'origin', '--delete', branch]);
    },
  };
}

function ghStringSliceItem(value: string): string {
  return /[",\r\n]/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

function parseOwnedPrLookup(out: string, marker: string): OwnedPrLookup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error('draft PR reconciliation returned invalid data');
  }
  if (!Array.isArray(parsed)) throw new Error('draft PR reconciliation returned invalid data');
  const candidates = parsed.map((item): { number: number; body: string; isDraft: boolean } => {
    if (
      typeof item !== 'object' ||
      item === null ||
      !Number.isSafeInteger((item as { number?: unknown }).number) ||
      (item as { number: number }).number <= 0 ||
      typeof (item as { body?: unknown }).body !== 'string' ||
      typeof (item as { isDraft?: unknown }).isDraft !== 'boolean'
    ) {
      throw new Error('draft PR reconciliation returned invalid data');
    }
    return item as { number: number; body: string; isDraft: boolean };
  });
  const matches = candidates.filter(
    (item) => item.isDraft && item.body.includes(marker),
  );
  if (matches.length > 1) throw new Error('draft PR reconciliation found multiple owned candidates');
  if (matches.length === 1) return { kind: 'owned', number: matches[0].number };
  return candidates.length === 0 ? { kind: 'absent' } : { kind: 'foreign' };
}

export function createRealAppBootstrapGitHub(repoDir: string): AppBootstrapGitHub {
  const gh = (args: string[], failure: string): Promise<string> =>
    run('gh', args, repoDir, failure);
  return {
    viewIssue: async (issue) => {
      try {
        const parsed = JSON.parse(
          await gh(
            ['issue', 'view', String(issue), '--json', 'title,url'],
            'issue lookup failed',
          ),
        );
        if (typeof parsed?.title === 'string' && typeof parsed?.url === 'string') {
          return { title: parsed.title, url: parsed.url };
        }
        return null;
      } catch {
        return null;
      }
    },
    assignIssueToSelf: async (issue) =>
      void (await gh(
        ['issue', 'edit', String(issue), '--add-assignee', '@me'],
        'issue assignment failed',
      )),
    setIssueLabel: async (issue, label, on) =>
      void (await gh(
        [
          'issue',
          'edit',
          String(issue),
          on ? '--add-label' : '--remove-label',
          ghStringSliceItem(label),
        ],
        'issue label update failed',
      )),
    createDraftPr: async ({ base, head, title, body }) => {
      let out: string;
      try {
        out = await gh(
          ['pr', 'create', '--draft', '--base', base, '--head', head, '--title', title, '--body', body],
          'draft PR creation failed',
        );
      } catch (e) {
        throw new AmbiguousBootstrapOperationError(errMsg(e));
      }
      const number = numberFromGithubUrl(out);
      if (number === null) {
        throw new AmbiguousBootstrapOperationError('draft PR creation outcome was not recognized');
      }
      return number;
    },
    findOwnedOpenPr: async ({ base, head, marker }) => {
      const out = await gh(
        [
          'pr',
          'list',
          '--state',
          'open',
          '--base',
          base,
          '--head',
          head,
          '--limit',
          '100',
          '--json',
          'number,body,isDraft',
        ],
        'draft PR reconciliation failed',
      );
      return parseOwnedPrLookup(out, marker);
    },
    closePr: async (pr) =>
      void (await gh(
        ['pr', 'close', String(pr)],
        'draft PR rollback failed',
      )),
    setPrLabel: async (pr, label, on) =>
      void (await gh(
        [
          'pr',
          'edit',
          String(pr),
          on ? '--add-label' : '--remove-label',
          ghStringSliceItem(label),
        ],
        'PR label update failed',
      )),
  };
}

export function createRealBootstrapGitHub(repoDir: string): BootstrapGitHub {
  const gh = (args: string[]): Promise<string> => runLegacy('gh', args, repoDir);
  return {
    viewIssue: async (issue) => {
      try {
        const parsed = JSON.parse(
          await gh(['issue', 'view', String(issue), '--json', 'title,url']),
        );
        if (typeof parsed?.title === 'string' && typeof parsed?.url === 'string') {
          return { title: parsed.title, url: parsed.url };
        }
        return null;
      } catch {
        return null;
      }
    },
    assignIssueToSelf: async (issue) =>
      void (await gh(['issue', 'edit', String(issue), '--add-assignee', '@me'])),
    setIssueLabel: async (issue, label, on) =>
      void (await gh([
        'issue',
        'edit',
        String(issue),
        on ? '--add-label' : '--remove-label',
        label,
      ])),
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
    setPrLabel: async (pr, label, on) =>
      void (await gh([
        'pr',
        'edit',
        String(pr),
        on ? '--add-label' : '--remove-label',
        label,
      ])),
  };
}
