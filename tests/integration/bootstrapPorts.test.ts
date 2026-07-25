import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AppBootstrapGitFaults, OwnedBootstrapBranchError } from '../../src/main/bootstrapPorts';
import { createRealAppBootstrapGit } from '../../src/main/appBootstrapGit';
import { createRealAppBootstrapGitHub } from '../../src/main/appBootstrapGithub';

const runGit = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

const hasRef = (cwd: string, ref: string): boolean => {
  try {
    execFileSync('git', ['show-ref', '--verify', '--quiet', ref], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('createRealAppBootstrapGit — owned remote-ref compensation', () => {
  const branch = 'plan-loop/issue-78';
  let root: string;
  let remote: string;
  let repo: string;

  const createOwnedBranch = async (faults: AppBootstrapGitFaults = {}) => {
    const port = createRealAppBootstrapGit(repo, faults);
    await port.createBranchFromBase(branch, 'main');
    const ownedOid = await port.commitEmptyStart('[skip ci] start work on #78');
    return { port, ownedOid };
  };

  const createPushedOwnedBranch = async () => {
    const created = await createOwnedBranch();
    const pushedOid = await created.port.pushBranchUpstream(branch, created.ownedOid);
    return { ...created, pushedOid };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bootstrap-ports-'));
    remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    repo = join(root, 'repo');
    runGit(root, ['init', '--bare', remote]);
    runGit(root, ['init', seed]);
    runGit(seed, ['config', 'user.email', 'test@example.test']);
    runGit(seed, ['config', 'user.name', 'Test']);
    writeFileSync(join(seed, 'README.md'), 'seed\n');
    runGit(seed, ['add', 'README.md']);
    runGit(seed, ['commit', '-m', 'seed']);
    runGit(seed, ['remote', 'add', 'origin', remote]);
    runGit(seed, ['push', 'origin', 'HEAD:refs/heads/main']);
    runGit(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    runGit(root, ['clone', remote, repo]);
    runGit(repo, ['config', 'user.email', 'test@example.test']);
    runGit(repo, ['config', 'user.name', 'Test']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('fails closed when the remote branch probe cannot be completed', async () => {
    runGit(repo, ['remote', 'set-url', 'origin', join(root, 'missing.git')]);
    const port = createRealAppBootstrapGit(repo);

    await expect(port.branchState('plan-loop/issue-78')).rejects.toThrow(/remote branch probe failed/i);
  });

  it('rejects command-capable repository-local Git configuration before it can execute', async () => {
    const marker = join(root, 'ssh-command-ran');
    runGit(repo, [
      'config',
      'core.sshCommand',
      `sh -c 'touch "${marker}"; exit 1'`,
    ]);
    runGit(repo, ['remote', 'set-url', 'origin', 'ssh://example.invalid/repo.git']);
    const port = createRealAppBootstrapGit(repo);

    await expect(port.branchState(branch)).rejects.toThrow(
      /unsafe repository-local git configuration/i,
    );

    expect(existsSync(marker)).toBe(false);
  });

  it('rejects repository-local work-tree redirection', async () => {
    const redirectedTree = join(root, 'redirected-worktree');
    mkdirSync(redirectedTree);
    runGit(repo, ['config', 'core.worktree', redirectedTree]);
    const port = createRealAppBootstrapGit(repo);

    await expect(port.branchState(branch)).rejects.toThrow(
      /unsafe repository-local git configuration/i,
    );
  });

  it('rejects a work-tree identity redirected through inherited Git state', async () => {
    const redirectedTree = join(root, 'inherited-worktree');
    mkdirSync(redirectedTree);
    const previousWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_WORK_TREE = redirectedTree;
    try {
      const port = createRealAppBootstrapGit(repo);
      await expect(port.branchState(branch)).rejects.toThrow(
        /repository identity mismatch/i,
      );
    } finally {
      if (previousWorkTree === undefined) {
        delete process.env.GIT_WORK_TREE;
      } else {
        process.env.GIT_WORK_TREE = previousWorkTree;
      }
    }
  });

  it('rejects a repository-local upload-pack override before a read operation', async () => {
    runGit(repo, ['config', 'remote.origin.uploadpack', 'git-upload-pack']);
    const port = createRealAppBootstrapGit(repo);

    await expect(port.branchState(branch)).rejects.toThrow(
      /unsafe repository-local git configuration/i,
    );
  });

  it('rejects a repository-local receive-pack override before a push operation', async () => {
    const port = createRealAppBootstrapGit(repo);
    await port.createBranchFromBase(branch, 'main');
    const ownedOid = await port.commitEmptyStart('[skip ci] start work on #78');
    runGit(repo, ['config', 'remote.origin.receivepack', 'git-receive-pack']);

    await expect(port.pushBranchUpstream(branch, ownedOid)).rejects.toThrow(
      /unsafe repository-local git configuration/i,
    );
  });

  it('neutralizes command-capable inherited Git configuration', async () => {
    const inheritedConfig = join(root, 'inherited.gitconfig');
    const hooks = join(root, 'inherited-hooks');
    const hookMarker = join(root, 'inherited-hook-ran');
    const uploadMarker = join(root, 'inherited-upload-pack-ran');
    const receiveMarker = join(root, 'inherited-receive-pack-ran');
    const uploadPack = join(root, 'upload-pack');
    const receivePack = join(root, 'receive-pack');
    mkdirSync(hooks);
    writeFileSync(
      join(hooks, 'post-checkout'),
      `#!/bin/sh\ntouch '${hookMarker}'\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(hooks, 'pre-push'),
      `#!/bin/sh\ntouch '${hookMarker}'\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      uploadPack,
      `#!/bin/sh\ntouch '${uploadMarker}'\nexec git-upload-pack "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      receivePack,
      `#!/bin/sh\ntouch '${receiveMarker}'\nexec git-receive-pack "$@"\n`,
      { mode: 0o755 },
    );
    runGit(root, ['config', '--file', inheritedConfig, 'core.hooksPath', hooks]);
    runGit(root, [
      'config',
      '--file',
      inheritedConfig,
      'remote.origin.uploadpack',
      uploadPack,
    ]);
    runGit(root, [
      'config',
      '--file',
      inheritedConfig,
      'remote.origin.receivepack',
      receivePack,
    ]);

    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = inheritedConfig;
    try {
      const port = createRealAppBootstrapGit(repo);
      expect((await port.branchState(branch)).remoteOid).toBe(null);
      await port.createBranchFromBase(branch, 'main');
      const ownedOid = await port.commitEmptyStart(
        '[skip ci] start work on #78',
      );
      await port.pushBranchUpstream(branch, ownedOid);
      await port.rollbackCreatedBranch(branch, ownedOid);
    } finally {
      if (previousGlobalConfig === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
      }
    }

    expect(existsSync(hookMarker)).toBe(false);
    expect(existsSync(uploadMarker)).toBe(false);
    expect(existsSync(receiveMarker)).toBe(false);
  });

  it('rejects a staged app-state file before creating the empty start commit', async () => {
    const report = join(repo, '.agent-terminal', 'loop', 'reports', '1.md');
    mkdirSync(join(repo, '.agent-terminal', 'loop', 'reports'), { recursive: true });
    writeFileSync(report, 'operator-private report\n');
    runGit(repo, ['add', report]);
    const port = createRealAppBootstrapGit(repo);

    expect(await port.isCleanTree()).toBe(false);
    expect(runGit(repo, ['diff', '--cached', '--name-only'])).toBe(
      '.agent-terminal/loop/reports/1.md',
    );
  });

  it('never commits user content staged after the clean-tree preflight', async () => {
    const port = createRealAppBootstrapGit(repo);
    const branch = 'plan-loop/issue-78';
    expect(await port.isCleanTree()).toBe(true);
    await port.createBranchFromBase(branch, 'main');
    writeFileSync(join(repo, 'raced.txt'), 'staged after preflight\n');
    runGit(repo, ['add', 'raced.txt']);

    const ownedOid = await port.commitEmptyStart('[skip ci] start work on #78');

    expect(runGit(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', ownedOid])).toBe('');
    expect(runGit(repo, ['diff', '--cached', '--name-only'])).toBe('raced.txt');
    await port.rollbackCreatedBranch(branch, ownedOid);
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
    expect(runGit(repo, ['diff', '--cached', '--name-only'])).toBe('raced.txt');
  });

  it('requires the remote ref to remain absent when the initial push lands', async () => {
    const port = createRealAppBootstrapGit(repo);
    expect((await port.branchState(branch)).remoteOid).toBe(null);
    await port.createBranchFromBase(branch, 'main');
    const ownedOid = await port.commitEmptyStart('[skip ci] start work on #78');

    const main = runGit(remote, ['rev-parse', 'refs/heads/main']);
    runGit(remote, ['update-ref', `refs/heads/${branch}`, main]);

    await expect(port.pushBranchUpstream(branch, ownedOid)).rejects.toThrow(/branch push failed/i);
    await expect(port.rollbackCreatedBranch(branch, ownedOid)).rejects.toThrow(
      /remote branch rollback refused/i,
    );
    expect(runGit(remote, ['rev-parse', `refs/heads/${branch}`])).toBe(main);
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
    expect(runGit(repo, ['branch', '--list', branch])).toBe('');

    const laterBranch = 'plan-loop/issue-79';
    await port.createBranchFromBase(laterBranch, 'main');
    await port.rollbackCreatedBranch(laterBranch, null);
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
    expect(runGit(repo, ['branch', '--list', laterBranch])).toBe('');
  });

  it('does not claim an exact-OID remote ref without a confirmed app push', async () => {
    const { port, ownedOid } = await createOwnedBranch();
    runGit(repo, ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`]);

    await port.rollbackCreatedBranch(branch, ownedOid);

    expect(hasRef(remote, `refs/heads/${branch}`)).toBe(true);
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
    expect(runGit(repo, ['branch', '--list', branch])).toBe('');
  });

  it('refuses to publish a local branch that advanced after the owned empty commit', async () => {
    const { port, ownedOid } = await createOwnedBranch();
    const tree = runGit(repo, ['rev-parse', `${ownedOid}^{tree}`]);
    const advancedOid = runGit(repo, [
      'commit-tree',
      tree,
      '-p',
      ownedOid,
      '-m',
      'concurrent user commit',
    ]);
    runGit(repo, ['update-ref', `refs/heads/${branch}`, advancedOid, ownedOid]);

    await expect(port.pushBranchUpstream(branch, ownedOid)).rejects.toThrow(
      /branch changed after bootstrap commit/i,
    );

    expect(hasRef(remote, `refs/heads/${branch}`)).toBe(false);
    expect(runGit(repo, ['rev-parse', branch])).toBe(advancedOid);
  });

  it('preserves an uncertain remote while cleaning the app-owned local branch', async () => {
    const { port, ownedOid } = await createOwnedBranch({
      pushResult: () => new Error('branch push result unavailable'),
    });

    await expect(port.pushBranchUpstream(branch, ownedOid)).rejects.toThrow(
      /branch push result unavailable/i,
    );
    expect(runGit(remote, ['rev-parse', `refs/heads/${branch}`])).toBe(ownedOid);
    await expect(port.rollbackCreatedBranch(branch, ownedOid)).rejects.toThrow(
      /remote branch rollback refused/i,
    );

    expect(hasRef(remote, `refs/heads/${branch}`)).toBe(true);
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
    expect(runGit(repo, ['branch', '--list', branch])).toBe('');
  });

  it('retains rollback ownership until a remote failure can be retried', async () => {
    const { port, pushedOid } = await createPushedOwnedBranch();
    runGit(repo, ['remote', 'set-url', 'origin', join(root, 'missing.git')]);

    await expect(port.rollbackCreatedBranch(branch, pushedOid)).rejects.toThrow(/remote branch rollback failed/i);
    expect(runGit(repo, ['branch', '--show-current'])).toBe(branch);
    expect(runGit(repo, ['branch', '--list', branch])).not.toBe('');

    runGit(repo, ['remote', 'set-url', 'origin', remote]);
    await port.rollbackCreatedBranch(branch, pushedOid);
    expect(hasRef(remote, `refs/heads/${branch}`)).toBe(false);
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
    expect(runGit(repo, ['branch', '--list', branch])).toBe('');
  });

  it('finishes remote compensation when the owned local ref is already absent', async () => {
    const { port, pushedOid } = await createPushedOwnedBranch();
    runGit(repo, ['switch', 'main']);
    runGit(repo, ['branch', '-D', branch]);

    await port.rollbackCreatedBranch(branch, pushedOid);

    expect(hasRef(remote, `refs/heads/${branch}`)).toBe(false);
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
    expect(runGit(repo, ['branch', '--list', branch])).toBe('');
  });

  it('refuses to delete a remote branch that advanced after this bootstrap pushed it', async () => {
    const { port, pushedOid } = await createPushedOwnedBranch();

    const other = join(root, 'other');
    runGit(root, ['clone', remote, other]);
    runGit(other, ['config', 'user.email', 'other@example.test']);
    runGit(other, ['config', 'user.name', 'Other']);
    runGit(other, ['checkout', branch]);
    writeFileSync(join(other, 'other.txt'), 'advanced\n');
    runGit(other, ['add', 'other.txt']);
    runGit(other, ['commit', '-m', 'advance branch']);
    runGit(other, ['push', 'origin', branch]);
    const advancedOid = runGit(remote, ['rev-parse', `refs/heads/${branch}`]);

    await expect(port.rollbackCreatedBranch(branch, pushedOid)).rejects.toThrow(/remote branch rollback refused/i);
    expect(runGit(remote, ['rev-parse', `refs/heads/${branch}`])).toBe(advancedOid);
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
    expect(runGit(repo, ['branch', '--list', branch])).toBe('');
  });

  it('refuses to delete a local branch that advanced after this bootstrap created it', async () => {
    const { port, pushedOid } = await createPushedOwnedBranch();
    writeFileSync(join(repo, 'local.txt'), 'local advance\n');
    runGit(repo, ['add', 'local.txt']);
    runGit(repo, ['commit', '-m', 'advance locally']);
    const advancedOid = runGit(repo, ['rev-parse', branch]);

    await expect(port.rollbackCreatedBranch(branch, pushedOid)).rejects.toThrow(
      /local branch rollback refused/i,
    );
    expect(runGit(repo, ['rev-parse', branch])).toBe(advancedOid);
    expect(hasRef(remote, `refs/heads/${branch}`)).toBe(false);
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
  });

  it('CAS-refuses local deletion when the branch advances during awaited remote cleanup', async () => {
    const { port, pushedOid: ownedOid } = await createPushedOwnedBranch();
    const tree = runGit(repo, ['rev-parse', `${ownedOid}^{tree}`]);
    const advancedOid = runGit(repo, [
      'commit-tree',
      tree,
      '-p',
      ownedOid,
      '-m',
      'advance during remote cleanup',
    ]);
    const escapedRepo = repo
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('$', '\\$')
      .replaceAll('`', '\\`');
    const hook = join(remote, 'hooks', 'pre-receive');
    writeFileSync(
      hook,
      '#!/bin/sh\n' +
        `env -u GIT_DIR -u GIT_WORK_TREE git -C "${escapedRepo}" update-ref refs/heads/${branch} ${advancedOid} ${ownedOid}\n` +
        'exit 0\n',
      { mode: 0o755 },
    );

    await expect(port.rollbackCreatedBranch(branch, ownedOid)).rejects.toThrow(
      /local branch rollback failed/i,
    );

    expect(hasRef(remote, `refs/heads/${branch}`)).toBe(false);
    expect(runGit(repo, ['rev-parse', branch])).toBe(advancedOid);
    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
  });

  it('retains typed ownership when checkout fails after the branch ref is created', async () => {
    const port = createRealAppBootstrapGit(repo, {
      checkoutResult: () => new Error('branch checkout failed'),
    });
    const branch = 'plan-loop/issue-78';

    await expect(port.createBranchFromBase(branch, 'main')).rejects.toBeInstanceOf(
      OwnedBootstrapBranchError,
    );
    await port.rollbackCreatedBranch(branch, null);

    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
    expect(hasRef(repo, `refs/heads/${branch}`)).toBe(false);
  });

  it('retains typed ownership when atomic branch creation lands before reporting failure', async () => {
    const port = createRealAppBootstrapGit(repo, {
      branchCreationResult: () => new Error('branch creation result unavailable'),
    });
    const branch = 'plan-loop/issue-78';

    await expect(port.createBranchFromBase(branch, 'main')).rejects.toBeInstanceOf(
      OwnedBootstrapBranchError,
    );
    await port.rollbackCreatedBranch(branch, null);

    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
    expect(hasRef(repo, `refs/heads/${branch}`)).toBe(false);
  });

  it('reconciles a landed empty commit after its first verification command fails', async () => {
    const port = createRealAppBootstrapGit(repo, {
      startCommitResult: () => new Error('start commit verification failed'),
    });
    const branch = 'plan-loop/issue-78';

    await port.createBranchFromBase(branch, 'main');
    await expect(
      port.commitEmptyStart('[skip ci] start work on #78'),
    ).rejects.toThrow(/start commit verification failed/i);
    await port.rollbackCreatedBranch(branch, null);

    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
    expect(hasRef(repo, `refs/heads/${branch}`)).toBe(false);
  });

  it('makes no mutation when the current checkout identity cannot be resolved', async () => {
    const port = createRealAppBootstrapGit(repo, {
      currentCheckoutResult: () => new Error('current checkout resolution unavailable'),
    });

    await expect(port.createBranchFromBase(branch, 'main')).rejects.toThrow(
      /current checkout resolution unavailable/i,
    );

    expect(runGit(repo, ['branch', '--show-current'])).toBe('main');
    expect(hasRef(repo, `refs/heads/${branch}`)).toBe(false);
  });

  it('does not replace caller-owned FETCH_HEAD while resolving the bootstrap base', async () => {
    runGit(repo, ['checkout', '-b', 'other']);
    writeFileSync(join(repo, 'other.txt'), 'other\n');
    runGit(repo, ['add', 'other.txt']);
    runGit(repo, ['commit', '-m', 'other']);
    runGit(repo, ['push', 'origin', 'other']);
    runGit(repo, ['switch', 'main']);
    runGit(repo, ['fetch', 'origin', 'other']);
    const fetchHead = join(repo, '.git', 'FETCH_HEAD');
    const callerFetchHead = readFileSync(fetchHead, 'utf8');
    const mainOid = runGit(repo, ['rev-parse', 'origin/main']);
    const port = createRealAppBootstrapGit(repo);

    await port.createBranchFromBase(branch, 'main');

    expect(runGit(repo, ['rev-parse', branch])).toBe(mainOid);
    expect(readFileSync(fetchHead, 'utf8')).toBe(callerFetchHead);
    await port.rollbackCreatedBranch(branch, null);
  });

  it('restores an option-shaped symbolic branch without interpreting it as checkout flags', async () => {
    const unusual = '--orphan=restored-by-option';
    const oid = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['update-ref', `refs/heads/${unusual}`, oid]);
    runGit(repo, ['symbolic-ref', 'HEAD', `refs/heads/${unusual}`]);
    const port = createRealAppBootstrapGit(repo);
    const branch = 'plan-loop/issue-78';

    await port.createBranchFromBase(branch, 'main');
    await port.rollbackCreatedBranch(branch, null);

    expect(runGit(repo, ['symbolic-ref', '--short', 'HEAD'])).toBe(unusual);
    expect(hasRef(repo, `refs/heads/${branch}`)).toBe(false);
  });

  it('restores the exact detached HEAD after compensating the created branch', async () => {
    const originalOid = runGit(repo, ['rev-parse', 'HEAD']);
    runGit(repo, ['checkout', '--detach', originalOid]);
    const port = createRealAppBootstrapGit(repo);
    const branch = 'plan-loop/issue-78';

    await port.createBranchFromBase(branch, 'main');
    await port.rollbackCreatedBranch(branch, null);

    expect(runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(runGit(repo, ['rev-parse', 'HEAD'])).toBe(originalOid);
    expect(hasRef(repo, `refs/heads/${branch}`)).toBe(false);
  });

  it('redacts tainted argv from surfaced command failures', async () => {
    const port = createRealAppBootstrapGit(repo);
    const taintedBase = 'private-base-name';

    await expect(
      port.createBranchFromBase('plan-loop/issue-78', taintedBase),
    ).rejects.toThrow(/^base fetch failed(?: \(exit \d+\))?$/);
  });

  it('reports both sides of a conflicting branch by object id', async () => {
    const port = createRealAppBootstrapGit(repo);
    expect(await port.branchState(branch)).toEqual({ localOid: null, remoteOid: null });

    const main = runGit(remote, ['rev-parse', 'refs/heads/main']);
    runGit(remote, ['update-ref', `refs/heads/${branch}`, main]);
    runGit(repo, ['branch', branch, 'main']);
    const localOid = runGit(repo, ['rev-parse', `refs/heads/${branch}`]);

    expect(await port.branchState(branch)).toEqual({ localOid, remoteOid: main });
  });

  it('deletes exactly the branch objects named by the caller', async () => {
    const port = createRealAppBootstrapGit(repo);
    const main = runGit(remote, ['rev-parse', 'refs/heads/main']);
    runGit(remote, ['update-ref', `refs/heads/${branch}`, main]);
    runGit(repo, ['branch', branch, 'main']);

    await port.deleteBranch(branch, await port.branchState(branch));

    expect(hasRef(repo, `refs/heads/${branch}`)).toBe(false);
    expect(hasRef(remote, `refs/heads/${branch}`)).toBe(false);
    expect(hasRef(remote, 'refs/heads/main')).toBe(true);
  });

  // The operator confirms a wipe against the resources they were shown; anything that moves between the
  // confirmation and the delete is a resource they never authorized destroying (§27.10).
  it('refuses to delete a branch that moved after the caller read its identity', async () => {
    const port = createRealAppBootstrapGit(repo);
    const main = runGit(remote, ['rev-parse', 'refs/heads/main']);
    runGit(remote, ['update-ref', `refs/heads/${branch}`, main]);
    runGit(repo, ['branch', branch, 'main']);
    const state = await port.branchState(branch);

    const seed = join(root, 'seed');
    runGit(seed, ['commit', '--allow-empty', '-m', 'moved']);
    runGit(seed, ['push', '--force', 'origin', `HEAD:refs/heads/${branch}`]);
    const movedOid = runGit(remote, ['rev-parse', `refs/heads/${branch}`]);

    await expect(port.deleteBranch(branch, state)).rejects.toThrow(/remote branch wipe failed/i);
    expect(runGit(remote, ['rev-parse', `refs/heads/${branch}`])).toBe(movedOid);
  });

  it('refuses to delete a local branch that moved after the caller read its identity', async () => {
    const port = createRealAppBootstrapGit(repo);
    runGit(repo, ['branch', branch, 'main']);
    const state = await port.branchState(branch);

    runGit(repo, ['checkout', branch]);
    runGit(repo, ['commit', '--allow-empty', '-m', 'moved']);
    const movedOid = runGit(repo, ['rev-parse', `refs/heads/${branch}`]);
    runGit(repo, ['checkout', 'main']);

    await expect(port.deleteBranch(branch, state)).rejects.toThrow(/local branch wipe failed/i);
    expect(runGit(repo, ['rev-parse', `refs/heads/${branch}`])).toBe(movedOid);
  });
});

describe('createRealAppBootstrapGitHub — owned PR reconciliation', () => {
  let root: string;
  let responseFile: string;
  let previousPath: string | undefined;
  let previousResponse: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bootstrap-github-'));
    responseFile = join(root, 'response.json');
    previousPath = process.env.PATH;
    previousResponse = process.env.FAKE_PR_LOOKUP_RESPONSE;
    writeFileSync(
      join(root, 'gh'),
      '#!/bin/sh\ncat "$FAKE_PR_LOOKUP_RESPONSE"\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${root}:${previousPath ?? ''}`;
    process.env.FAKE_PR_LOOKUP_RESPONSE = responseFile;
  });

  afterEach(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousResponse === undefined) delete process.env.FAKE_PR_LOOKUP_RESPONSE;
    else process.env.FAKE_PR_LOOKUP_RESPONSE = previousResponse;
    rmSync(root, { recursive: true, force: true });
  });

  it('selects only one marked draft and distinguishes absent from foreign PRs', async () => {
    const github = createRealAppBootstrapGitHub(root);
    writeFileSync(responseFile, '[]');
    await expect(
      github.findOwnedOpenPr({ base: 'main', head: 'topic', marker: '<!-- owned -->' }),
    ).resolves.toEqual({ kind: 'absent' });
    writeFileSync(
      responseFile,
      JSON.stringify([{ number: 9, body: 'collaborator', isDraft: true }]),
    );
    await expect(
      github.findOwnedOpenPr({ base: 'main', head: 'topic', marker: '<!-- owned -->' }),
    ).resolves.toEqual({ kind: 'foreign' });
    writeFileSync(responseFile, JSON.stringify([
      { number: 9, body: '<!-- owned -->', isDraft: false },
      { number: 10, body: '<!-- owned -->', isDraft: true },
    ]));
    await expect(
      github.findOwnedOpenPr({ base: 'main', head: 'topic', marker: '<!-- owned -->' }),
    ).resolves.toEqual({ kind: 'owned', number: 10 });
  });

  it('fails closed for malformed or multiply-owned reconciliation data', async () => {
    const github = createRealAppBootstrapGitHub(root);
    const find = () =>
      github.findOwnedOpenPr({ base: 'main', head: 'topic', marker: '<!-- owned -->' });
    writeFileSync(responseFile, JSON.stringify([{ number: 0, body: '', isDraft: true }]));
    await expect(find()).rejects.toThrow(/invalid data/i);
    writeFileSync(responseFile, JSON.stringify([
      { number: 9, body: '<!-- owned -->', isDraft: true },
      { number: 10, body: '<!-- owned -->', isDraft: true },
    ]));
    await expect(find()).rejects.toThrow(/multiple owned/i);
    writeFileSync(responseFile, 'not-json');
    await expect(find()).rejects.toThrow(/invalid data/i);
  });
});
