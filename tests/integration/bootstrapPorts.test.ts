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
import { createGitHubRepositorySource } from '../../src/main/githubRepository';

const runGit = (cwd: string, args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// Every key git's upstream bookkeeping wrote for the branch. `git config --get-regexp` exits 1 when the
// section is gone, which is what "removed" looks like.
const branchConfig = (cwd: string, branch: string): string => {
  try {
    return execFileSync('git', ['config', '--get-regexp', `^branch\\.${branch}\\.`], {
      cwd,
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
};

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

  const branchSection = (): string => branchConfig(repo, branch);

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

  it('bootstraps a repo whose own config sets core.hooksPath, without running those hooks', async () => {
    const hooks = join(root, 'repo-hooks');
    const marker = join(root, 'repo-hook-ran');
    mkdirSync(hooks);
    for (const hook of ['post-checkout', 'pre-commit', 'commit-msg', 'post-commit', 'pre-push', 'reference-transaction']) {
      writeFileSync(join(hooks, hook), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
    }
    runGit(repo, ['config', 'core.hooksPath', hooks]);

    const { port, ownedOid } = await createOwnedBranch();
    await expect(port.pushBranchUpstream(branch, ownedOid)).resolves.toBe(ownedOid);

    expect(runGit(remote, ['rev-parse', `refs/heads/${branch}`])).toBe(ownedOid);
    expect(existsSync(marker)).toBe(false);
  });

  it('never runs a repository-local core.sshCommand', async () => {
    const marker = join(root, 'ssh-command-ran');
    runGit(repo, [
      'config',
      'core.sshCommand',
      `sh -c 'touch "${marker}"; exit 1'`,
    ]);
    runGit(repo, ['remote', 'set-url', 'origin', 'ssh://127.0.0.1:1/repo.git']);
    const port = createRealAppBootstrapGit(repo);

    await expect(port.branchState(branch)).rejects.toThrow(/remote branch probe failed/i);

    expect(existsSync(marker)).toBe(false);
  });

  it('rejects repository-local work-tree redirection', async () => {
    const redirectedTree = join(root, 'redirected-worktree');
    mkdirSync(redirectedTree);
    runGit(repo, ['config', 'core.worktree', redirectedTree]);
    const port = createRealAppBootstrapGit(repo);

    await expect(port.branchState(branch)).rejects.toThrow(/repository identity mismatch/i);
  });

  // Inherited repository-selection variables are stripped from every child, so the port operates on the
  // repo it was constructed for rather than merely detecting the redirect after the fact.
  it('ignores a work-tree redirected through inherited Git state', async () => {
    const redirectedTree = join(root, 'inherited-worktree');
    mkdirSync(redirectedTree);
    const previousWorkTree = process.env.GIT_WORK_TREE;
    const previousGitDir = process.env.GIT_DIR;
    process.env.GIT_WORK_TREE = redirectedTree;
    process.env.GIT_DIR = join(redirectedTree, '.git');
    try {
      const port = createRealAppBootstrapGit(repo);
      await expect(port.branchState(branch)).resolves.toEqual({
        localOid: null,
        remoteOid: null,
      });
    } finally {
      if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previousWorkTree;
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
    }
  });

  it('grades the origin URL the remote operation uses, not a rewritten one', async () => {
    runGit(repo, ['config', 'remote.origin.url', '-upload-pack=evil']);
    runGit(repo, [
      'config',
      'url.https://example.invalid/.insteadOf',
      '-upload-pack=evil',
    ]);
    const port = createRealAppBootstrapGit(repo);

    await expect(port.branchState(branch)).rejects.toThrow(
      /unsafe origin transport configuration/i,
    );
  });

  // Two consumers read this one list: this probe and resolveGitHubRepository, which already refuses a
  // multi-valued origin. Two rules over one list are indistinguishable from one until the list has two
  // elements — at which point the URL graded here and the URL the identity lookup approved differ.
  it('refuses a multi-valued origin rather than picking one of its URLs', async () => {
    runGit(repo, [
      'config',
      '--add',
      'remote.origin.url',
      `${remote}-second`,
    ]);
    const port = createRealAppBootstrapGit(repo);

    await expect(port.branchState(branch)).rejects.toThrow(
      /unsafe origin transport configuration/i,
    );
  });

  it('never runs a repository-local upload-pack override on a read operation', async () => {
    const marker = join(root, 'upload-pack-ran');
    runGit(repo, ['config', 'remote.origin.uploadpack', `touch "${marker}"; git-upload-pack`]);
    const port = createRealAppBootstrapGit(repo);

    await expect(port.branchState(branch)).resolves.toEqual({ localOid: null, remoteOid: null });

    expect(existsSync(marker)).toBe(false);
  });

  it('never runs a repository-local receive-pack override on a push operation', async () => {
    const marker = join(root, 'receive-pack-ran');
    const { port, ownedOid } = await createOwnedBranch();
    runGit(repo, ['config', 'remote.origin.receivepack', `touch "${marker}"; git-receive-pack`]);

    await expect(port.pushBranchUpstream(branch, ownedOid)).resolves.toBe(ownedOid);

    expect(existsSync(marker)).toBe(false);
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
    // The remote operations address the remote by URL, not by the name `origin`, so git resolves these
    // keys as remote.<url>.* — pinning remote.origin.* neutralizes nothing on that path. Both spellings
    // are planted so the test covers whichever addressing the port uses.
    const originUrl = `file://${remote}`;
    runGit(repo, ['config', 'remote.origin.url', originUrl]);
    runGit(root, [
      'config',
      '--file',
      inheritedConfig,
      `remote.${originUrl}.uploadpack`,
      uploadPack,
    ]);
    runGit(root, [
      'config',
      '--file',
      inheritedConfig,
      `remote.${originUrl}.receivepack`,
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

  it('neutralizes an inherited command-capable core.fsmonitor on an index-refreshing operation', async () => {
    // core.fsmonitor is the OTHER command lever the shared hardening covers: git runs it to refresh the index
    // (e.g. during `git status`). An inherited value is not caught by the local-config allow-list, so the
    // `-c core.fsmonitor=false` override is what stops it — dropping that arg makes this marker appear.
    const inheritedConfig = join(root, 'fsmonitor.gitconfig');
    const fsmonitorMarker = join(root, 'inherited-fsmonitor-ran');
    const fsmonitor = join(root, 'fsmonitor-hook');
    writeFileSync(fsmonitor, `#!/bin/sh\ntouch '${fsmonitorMarker}'\n`, { mode: 0o755 });
    runGit(root, ['config', '--file', inheritedConfig, 'core.fsmonitor', fsmonitor]);

    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = inheritedConfig;
    try {
      await createRealAppBootstrapGit(repo).isCleanTree(); // `git status --porcelain` refreshes the index
    } finally {
      if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
    }

    expect(existsSync(fsmonitorMarker)).toBe(false);
  });

  it('rejects a staged app-state file before creating the empty start commit', async () => {
    const report = join(repo, '.agent-terminal', 'loop', 'reports', '1.md');
    mkdirSync(join(repo, '.agent-terminal', 'loop', 'reports'), { recursive: true });
    writeFileSync(report, 'operator-private report\n');
    runGit(repo, ['add', '-f', report]);
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

  // Same shape as the wipe: the rollback deletes through the URL-addressed port, which performs none of
  // the local bookkeeping a delete-push to a NAMED remote and `git branch -D` do. The tracking ref this
  // port wrote by hand on push has to come back off on rollback, or the branch outlives itself.
  it('clears the tracking ref and branch config it wrote when rolling back a pushed branch', async () => {
    const { port, ownedOid } = await createPushedOwnedBranch();
    expect(hasRef(repo, `refs/remotes/origin/${branch}`)).toBe(true);
    expect(branchSection()).toContain('.remote origin');
    expect(branchSection()).toContain('.merge ');

    await port.rollbackCreatedBranch(branch, ownedOid);

    expect(hasRef(repo, `refs/remotes/origin/${branch}`)).toBe(false);
    // The whole section, not one key: `--set-upstream-to` writes branch.<n>.remote AND .merge, and the
    // fix removes the section — reading only .remote would pass a narrower `--unset` that leaves .merge.
    expect(branchSection()).toBe('');
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

  // Two properties, not one. The operator needs to tell a timeout apart from a bad remote apart from a
  // missing base, so the classification must survive; the argv must not, because a base branch name is
  // tainted. Anchoring the whole message enforced the second by discarding the first.
  it('surfaces the failure classification but never the tainted argv', async () => {
    const port = createRealAppBootstrapGit(repo);
    const taintedBase = 'private-base-name';

    const failure = await port
      .createBranchFromBase('plan-loop/issue-78', taintedBase)
      .then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );

    expect(failure).toMatch(/^base fetch failed/);
    expect(failure).toMatch(/exit \d+|timed out|could not start|output limit/);
    expect(failure).not.toContain(taintedBase);
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
    expect(hasRef(repo, `refs/heads/${branch}`)).toBe(true);
    expect(runGit(repo, ['rev-parse', `refs/heads/${branch}`])).toBe(state.localOid);
  });

  it('detaches HEAD off the branch it is asked to delete', async () => {
    const port = createRealAppBootstrapGit(repo);
    runGit(repo, ['checkout', '-b', branch, 'main']);
    const state = await port.branchState(branch);

    await port.deleteBranch(branch, state);

    expect(hasRef(repo, `refs/heads/${branch}`)).toBe(false);
    expect(runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    expect(runGit(repo, ['rev-parse', 'HEAD'])).toBe(state.localOid);
  });

  // The stale-lease abort must destroy nothing on either side — including the operator's checkout. The
  // detach runs before update-ref performs the lease check, so this is the combination that matters.
  it('leaves the checkout alone when the branch it is on moved past the lease', async () => {
    const port = createRealAppBootstrapGit(repo);
    runGit(repo, ['checkout', '-b', branch, 'main']);
    const state = await port.branchState(branch);
    runGit(repo, ['commit', '--allow-empty', '-m', 'moved']);
    const movedOid = runGit(repo, ['rev-parse', `refs/heads/${branch}`]);

    await expect(port.deleteBranch(branch, state)).rejects.toThrow(
      /local branch wipe failed/i,
    );

    expect(hasRef(repo, `refs/heads/${branch}`)).toBe(true);
    expect(runGit(repo, ['rev-parse', `refs/heads/${branch}`])).toBe(movedOid);
    expect(runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branch);
    expect(runGit(repo, ['rev-parse', 'HEAD'])).toBe(movedOid);
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

  // The local leg detaches HEAD before deleting the ref, so anything that fails BETWEEN the two leaves
  // the operator on a detached HEAD they never asked for — with the remote half already destroyed and no
  // UI action that restores either. A stale ref lock triggers it deterministically: rev-parse and
  // `checkout --detach` do not touch refs/heads/<branch>.lock, and only `update-ref -d` takes it.
  it('restores the checkout when the local wipe fails after detaching', async () => {
    const port = createRealAppBootstrapGit(repo);
    const main = runGit(remote, ['rev-parse', 'refs/heads/main']);
    runGit(remote, ['update-ref', `refs/heads/${branch}`, main]);
    runGit(repo, ['checkout', '-q', '-b', branch, 'main']);
    const state = await port.branchState(branch);
    writeFileSync(join(repo, '.git', 'refs', 'heads', `${branch}.lock`), '');

    await expect(port.deleteBranch(branch, state)).rejects.toThrow(
      /local branch wipe failed/i,
    );
    expect(runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branch);
  });

  // The other arm of the same repair: when the restore ITSELF fails, the operator is on a detached HEAD
  // with the remote half already destroyed. That is the worst state this port produces, so the message
  // has to name it rather than report only that the wipe failed.
  it('reports the detached HEAD when the restore itself fails', async () => {
    const port = createRealAppBootstrapGit(repo, {
      restoreCheckoutResult: () => new Error('restore refused'),
    });
    const main = runGit(remote, ['rev-parse', 'refs/heads/main']);
    runGit(remote, ['update-ref', `refs/heads/${branch}`, main]);
    runGit(repo, ['checkout', '-q', '-b', branch, 'main']);
    const state = await port.branchState(branch);
    writeFileSync(join(repo, '.git', 'refs', 'heads', `${branch}.lock`), '');

    await expect(port.deleteBranch(branch, state)).rejects.toThrow(
      /HEAD is detached and the previous checkout could not be restored/i,
    );
  });

  // The isolated dir has no remotes, so deleting through it leaves the remote-tracking ref and the
  // branch config that a delete-push to a named remote and `git branch -D` remove for free — and this
  // port already compensates the PUSH direction by hand for the same reason. A wipe that leaves
  // refs/remotes/origin/<branch> behind shows the operator a branch that no longer exists.
  it('clears the tracking ref and branch config the wipe deleted the branch for', async () => {
    const { port, pushedOid } = await createPushedOwnedBranch();
    expect(hasRef(repo, `refs/remotes/origin/${branch}`)).toBe(true);
    expect(branchSection()).toContain('.remote origin');
    expect(branchSection()).toContain('.merge ');

    await port.deleteBranch(branch, {
      localOid: pushedOid,
      remoteOid: pushedOid,
    });

    expect(hasRef(repo, `refs/remotes/origin/${branch}`)).toBe(false);
    expect(branchSection()).toBe('');
  });

  // main's wipe deleted the local branch with the porcelain `git branch -D`, which REFUSES a branch any
  // worktree has checked out; the plumbing `update-ref -d` that replaced it has no such check, and the
  // detach arm only moves repoDir's own HEAD. Deleting the ref leaves the other worktree on a branch
  // that no longer exists.
  it('refuses to delete a branch another worktree has checked out', async () => {
    const port = createRealAppBootstrapGit(repo);
    runGit(repo, ['branch', branch, 'main']);
    const otherTree = join(root, 'other-worktree');
    runGit(repo, ['worktree', 'add', otherTree, branch]);
    const state = await port.branchState(branch);

    await expect(port.deleteBranch(branch, state)).rejects.toThrow(
      /local branch wipe failed/i,
    );
    expect(hasRef(repo, `refs/heads/${branch}`)).toBe(true);
  });

  // The cleanup has to run with the act that makes it true, not once at the end: a wipe whose remote
  // delete lands and whose local leg then fails must still not leave a tracking ref for a branch that
  // is gone from origin. Moving it to a single tail call regressed exactly this.
  it('clears the tracking ref when the remote delete lands and the local leg then fails', async () => {
    const { port, pushedOid } = await createPushedOwnedBranch();
    expect(hasRef(repo, `refs/remotes/origin/${branch}`)).toBe(true);
    writeFileSync(join(repo, '.git', 'refs', 'heads', `${branch}.lock`), '');

    await expect(
      port.deleteBranch(branch, { localOid: pushedOid, remoteOid: pushedOid }),
    ).rejects.toThrow(/local branch wipe failed/i);

    expect(hasRef(remote, `refs/heads/${branch}`)).toBe(false);
    expect(hasRef(repo, `refs/remotes/origin/${branch}`)).toBe(false);
  });

  // No plumbing query expresses git's "branch is in use" rule: mid-rebase, `worktree list --porcelain`
  // reports `detached` with no branch line and `for-each-ref %(worktreepath)` is empty, while
  // `git branch -D` still refuses. The wipe must refuse the same, or it destroys a branch a rebase is
  // actively rewriting.
  it('refuses to delete a branch a rebase in progress is rewriting', async () => {
    const port = createRealAppBootstrapGit(repo);
    runGit(repo, ['checkout', '-q', '-b', branch, 'main']);
    writeFileSync(join(repo, 'one.txt'), 'one\n');
    runGit(repo, ['add', 'one.txt']);
    runGit(repo, ['commit', '-m', 'one']);
    writeFileSync(join(repo, 'two.txt'), 'two\n');
    runGit(repo, ['add', 'two.txt']);
    runGit(repo, ['commit', '-m', 'two']);
    const state = await port.branchState(branch);
    try {
      execFileSync('git', ['rebase', '-i', '--exec', 'false', 'main'], {
        cwd: repo,
        env: { ...process.env, GIT_SEQUENCE_EDITOR: 'true' },
        stdio: 'ignore',
      });
    } catch {
      /* the --exec false stops the rebase mid-flight, which is the state under test */
    }

    // The reason must name the cause: git's stderr carries the branch name and cannot be surfaced,
    // and a bare exit code tells the operator nothing they can act on.
    await expect(port.deleteBranch(branch, state)).rejects.toThrow(
      /while it is in use/i,
    );
    expect(hasRef(repo, `refs/heads/${branch}`)).toBe(true);
  });

  // main pushed with `git push -u`, which writes the tracking ref AND its config in one operation. The
  // split writes the ref by hand and then asks `--set-upstream-to` to resolve it, which goes through the
  // remote's FETCH REFSPEC — so on a single-branch clone the upstream step fails outright.
  it('publishes a branch on a clone whose fetch refspec covers only the base', async () => {
    runGit(repo, [
      'config',
      '--replace-all',
      'remote.origin.fetch',
      '+refs/heads/main:refs/remotes/origin/main',
    ]);
    const { port, ownedOid } = await createOwnedBranch();

    await expect(port.pushBranchUpstream(branch, ownedOid)).resolves.toBe(ownedOid);
    expect(runGit(repo, ['config', '--get', `branch.${branch}.remote`])).toBe('origin');
    expect(runGit(repo, ['config', '--get', `branch.${branch}.merge`])).toBe(
      `refs/heads/${branch}`,
    );
  });

  // BOTH halves present, which the other refusal tests lack: an in-use refusal that only fires at the
  // local delete arrives after the remote half is already gone, so the operator is left with a
  // half-wiped state. The refusal has to reach them before anything is destroyed.
  it('refuses a worktree-held branch before the remote half is destroyed', async () => {
    const port = createRealAppBootstrapGit(repo);
    const main = runGit(remote, ['rev-parse', 'refs/heads/main']);
    runGit(remote, ['update-ref', `refs/heads/${branch}`, main]);
    runGit(repo, ['branch', branch, 'main']);
    const otherTree = join(root, 'held-worktree');
    runGit(repo, ['worktree', 'add', otherTree, branch]);
    const state = await port.branchState(branch);
    expect(state.remoteOid).not.toBeNull();

    await expect(port.deleteBranch(branch, state)).rejects.toThrow(
      /local branch wipe failed/i,
    );
    expect(hasRef(remote, `refs/heads/${branch}`)).toBe(true);
    expect(hasRef(repo, `refs/heads/${branch}`)).toBe(true);
  });

  // The lease has to hold across the remote leg, not just before it: the identity is read, then a
  // network push runs on a 60 s budget, and only then is the local branch deleted. A branch the hosted
  // agent moves during that window must not be destroyed.
  it('refuses a branch that moved during the remote leg', async () => {
    const main = runGit(remote, ['rev-parse', 'refs/heads/main']);
    runGit(remote, ['update-ref', `refs/heads/${branch}`, main]);
    runGit(repo, ['branch', branch, 'main']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'later']);
    const moveTo = runGit(repo, ['rev-parse', 'HEAD']);
    let moved = false;
    const port = createRealAppBootstrapGit(repo, {
      // Fires after the remote delete and before the local one — the window under test.
      currentCheckoutResult: () => {
        if (!moved) {
          moved = true;
          runGit(repo, ['branch', '-f', branch, moveTo]);
        }
        return null;
      },
    });
    const state = await port.branchState(branch);

    await expect(port.deleteBranch(branch, state)).rejects.toThrow(
      /branch changed after the caller read its identity/i,
    );
    expect(runGit(repo, ['rev-parse', `refs/heads/${branch}`])).toBe(moveTo);
  });

  // Each cache belongs to the act that orphans it: the tracking ref to the remote delete, the branch
  // config to the local one. Cleaning both wherever either lands strips the upstream config of a branch
  // the operator still has, when the remote half went and the local delete then failed.
  it('keeps the branch config when the local branch survives a failed wipe', async () => {
    const { port, pushedOid } = await createPushedOwnedBranch();
    expect(branchSection()).toContain('.remote origin');
    writeFileSync(join(repo, '.git', 'refs', 'heads', `${branch}.lock`), '');

    await expect(
      port.deleteBranch(branch, { localOid: pushedOid, remoteOid: pushedOid }),
    ).rejects.toThrow(/local branch wipe failed/i);

    expect(hasRef(repo, `refs/remotes/origin/${branch}`)).toBe(false);
    expect(hasRef(repo, `refs/heads/${branch}`)).toBe(true);
    expect(branchSection()).toContain('.remote origin');
  });

  // Either lease refusing must leave BOTH halves intact: a wipe that destroys the origin branch and then
  // refuses the local one strands the operator in a state no UI action reaches (§27.10).
  it('refuses a moved local branch without destroying the remote half first', async () => {
    const port = createRealAppBootstrapGit(repo);
    const main = runGit(remote, ['rev-parse', 'refs/heads/main']);
    runGit(remote, ['update-ref', `refs/heads/${branch}`, main]);
    runGit(repo, ['branch', branch, 'main']);
    const state = await port.branchState(branch);
    expect(state.remoteOid).not.toBeNull();

    runGit(repo, ['checkout', branch]);
    runGit(repo, ['commit', '--allow-empty', '-m', 'moved']);
    runGit(repo, ['checkout', 'main']);

    // The §27.10 chart's "failed before anything was destroyed, checkout restored" edge, asserted in
    // full: nothing in the suite can falsify a chart edge, so the residue taxonomy the wipe's safety
    // argument rests on is bound here instead — every artifact that edge promises survives.
    await expect(port.deleteBranch(branch, state)).rejects.toThrow(/local branch wipe failed/i);
    expect(hasRef(remote, `refs/heads/${branch}`)).toBe(true);
    expect(hasRef(repo, `refs/heads/${branch}`)).toBe(true);
    expect(runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
  });
});

describe('createRealAppBootstrapGitHub — repository pinning', () => {
  let root: string;
  let repo: string;
  let log: string;
  let previousPath: string | undefined;
  let previousLog: string | undefined;
  let previousRepository: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bootstrap-github-pin-'));
    repo = join(root, 'repo');
    log = join(root, 'gh.log');
    mkdirSync(repo);
    runGit(repo, ['init']);
    runGit(repo, [
      'remote',
      'add',
      'origin',
      'https://github.com/owner/repository.git',
    ]);
    writeFileSync(
      join(root, 'gh'),
      '#!/usr/bin/env bash\n' +
        'printf \'%s GH_REPO=%s\\n\' "$*" "${GH_REPO-unset}" >> "$FAKE_GH_LOG"\n' +
        'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
        'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then case " $* " in *" --body-file - "*) cat > "$FAKE_GH_LOG.stdin";; esac; printf \'%s\\n\' "https://github.com/owner/repository/pull/7"; exit 0; fi\n' +
        'exit 0\n',
      { mode: 0o755 },
    );
    previousPath = process.env.PATH;
    previousLog = process.env.FAKE_GH_LOG;
    previousRepository = process.env.GH_REPO;
    process.env.PATH = `${root}:${previousPath ?? ''}`;
    process.env.FAKE_GH_LOG = log;
    process.env.GH_REPO = 'attacker/other';
  });

  afterEach(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.FAKE_GH_LOG;
    else process.env.FAKE_GH_LOG = previousLog;
    if (previousRepository === undefined) delete process.env.GH_REPO;
    else process.env.GH_REPO = previousRepository;
    rmSync(root, { recursive: true, force: true });
  });

  it('names the resolved origin on every mutation and drops an inherited GH_REPO', async () => {
    const github = createRealAppBootstrapGitHub(
      repo,
      createGitHubRepositorySource(repo),
    );

    await github.createDraftPr({
      base: 'main',
      head: 'plan-loop/issue-78',
      title: 'title',
      body: 'body',
    });
    await github.assignIssueToSelf(78);
    await github.setIssueLabel(78, 'agent-loop/in-progress', true);
    await github.setPrLabel(7, 'plan-draft', true);
    await github.closePr(7);

    const recorded = readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('repo view'));
    expect(recorded.length).toBeGreaterThan(0);
    for (const line of recorded) {
      expect(line).toContain('--repo github.com/owner/repository');
      expect(line).toContain('GH_REPO=unset');
    }
  });

  it('sends the draft PR body on stdin, never on the command line', async () => {
    const github = createRealAppBootstrapGitHub(repo, createGitHubRepositorySource(repo));
    const body = 'Closes #78\n\nA body that must not travel as an argument.';

    await github.createDraftPr({ base: 'main', head: 'plan-loop/issue-78', title: 'title', body });

    const argv = readFileSync(log, 'utf8');
    expect.soft(argv).not.toContain('must not travel');
    expect.soft(argv.split('\n').find((line) => line.startsWith('pr create'))).toContain('--body-file -');
    expect.soft(readFileSync(`${log}.stdin`, 'utf8')).toBe(body);
  });

  it('refuses a created PR URL that names another repository', async () => {
    writeFileSync(
      join(root, 'gh'),
      '#!/usr/bin/env bash\n' +
        'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
        'case " $* " in *" --body-file - "*) cat > /dev/null;; esac\n' +
        'printf \'%s\\n\' "https://github.com/attacker/other/pull/7"\n',
      { mode: 0o755 },
    );
    const github = createRealAppBootstrapGitHub(
      repo,
      createGitHubRepositorySource(repo),
    );

    await expect(
      github.createDraftPr({
        base: 'main',
        head: 'plan-loop/issue-78',
        title: 'title',
        body: 'body',
      }),
    ).rejects.toThrow(/not recognized|ambiguous|repository/i);
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
    runGit(root, ['init']);
    runGit(root, [
      'remote',
      'add',
      'origin',
      'https://github.com/owner/repository.git',
    ]);
    writeFileSync(
      join(root, 'gh'),
      '#!/bin/sh\n' +
        'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
        'cat "$FAKE_PR_LOOKUP_RESPONSE"\n',
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
    const github = createRealAppBootstrapGitHub(
      root,
      createGitHubRepositorySource(root),
    );
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
    const github = createRealAppBootstrapGitHub(
      root,
      createGitHubRepositorySource(root),
    );
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
