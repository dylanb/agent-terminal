import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAppBootstrapConflicts,
  type AppBootstrapConflictStore,
} from '../../src/main/appBootstrapConflicts';
import { createRealAppBootstrapPorts } from '../../src/main/appBootstrapPorts';
import type { AppBootstrapConflictTarget } from '../../src/shared/appBootstrap';

const cleanup: string[] = [];
const originalPath = process.env.PATH;
const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

function realGitRepo(): {
  repo: string;
  git(args: string[]): string;
} {
  const repo = mkdtempSync(path.join(tmpdir(), 'bootstrap-ports-'));
  cleanup.push(repo);
  const git = (args: string[]): string =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Bootstrap Test']);
  git(['config', 'user.email', 'bootstrap@example.test']);
  writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'base']);
  return { repo, git };
}

describe('app bootstrap conflict port', () => {
  it('condition-checks and deletes exact refs before closing pull requests', async () => {
    const target: AppBootstrapConflictTarget = {
      repository: 'github.com/owner/repository',
      branch: 'plan-loop/issue-78',
      localOid: '1'.repeat(40),
      remoteOid: '2'.repeat(40),
      pullRequests: [41],
    };
    const store: AppBootstrapConflictStore = {
      inspect: async () => target,
      closePullRequest: async () => {
        if (target.localOid !== null || target.remoteOid !== null) {
          throw new Error('ref remained when PR close was attempted');
        }
        target.pullRequests = [];
      },
      deleteLocalBranch: async () => {
        target.localOid = null;
      },
      deleteRemoteBranch: async () => {
        target.remoteOid = null;
      },
    };

    const conflicts = createAppBootstrapConflicts(store);
    await conflicts.wipe(await conflicts.inspect('plan-loop/issue-78'));

    expect(await conflicts.inspect('plan-loop/issue-78')).toMatchObject({
      localOid: null,
      remoteOid: null,
      pullRequests: [],
    });
  });

  it('is safely resumable when PR closure fails after the exact refs are deleted', async () => {
    const target: AppBootstrapConflictTarget = {
      repository: 'github.com/owner/repository',
      branch: 'plan-loop/issue-78',
      localOid: '1'.repeat(40),
      remoteOid: '2'.repeat(40),
      pullRequests: [41],
    };
    let closeAttempts = 0;
    const store: AppBootstrapConflictStore = {
      inspect: async () => target,
      deleteLocalBranch: async () => {
        target.localOid = null;
      },
      deleteRemoteBranch: async () => {
        target.remoteOid = null;
      },
      closePullRequest: async () => {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error('transient close failure');
        target.pullRequests = [];
      },
    };
    const conflicts = createAppBootstrapConflicts(store);
    const firstSnapshot = await conflicts.inspect(target.branch);

    await expect(conflicts.wipe(firstSnapshot)).rejects.toThrow(
      /transient close failure/,
    );
    expect(await conflicts.inspect(target.branch)).toEqual({
      ...firstSnapshot,
      localOid: null,
      remoteOid: null,
    });

    const remaining = await conflicts.inspect(target.branch);
    await conflicts.wipe(remaining);
    expect(await conflicts.inspect(target.branch)).toMatchObject({
      localOid: null,
      remoteOid: null,
      pullRequests: [],
    });
  });
});

describe('bootstrap start commit', () => {
  it('does not replace a remote branch created after conflict inspection', async () => {
    const { git, repo } = realGitRepo();
    const remote = mkdtempSync(path.join(tmpdir(), 'bootstrap-remote-race-'));
    cleanup.push(remote);
    execFileSync('git', ['init', '--bare'], { cwd: remote });
    const branch = 'plan-loop/issue-78';
    const competingOid = git(['rev-parse', 'HEAD']);
    git(['push', remote, `HEAD:refs/heads/${branch}`]);
    git(['checkout', '-b', branch]);
    const bin = mkdtempSync(path.join(tmpdir(), 'bootstrap-remote-race-bin-'));
    const config = path.join(
      mkdtempSync(path.join(tmpdir(), 'bootstrap-remote-race-config-')),
      'gitconfig',
    );
    cleanup.push(bin, path.dirname(config));
    git([
      'remote',
      'add',
      'origin',
      'https://github.com/owner/repository.git',
    ]);
    writeFileSync(
      path.join(bin, 'gh'),
      '#!/usr/bin/env bash\n' +
        'printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    const ports = createRealAppBootstrapPorts(repo);
    await expect(ports.git.resolveBaseBranch()).resolves.toBe('main');
    execFileSync(
      'git',
      [
        'config',
        '--file',
        config,
        `url.file://${remote}/.insteadOf`,
        'https://github.com/owner/repository.git',
      ],
    );
    process.env.GIT_CONFIG_GLOBAL = config;
    const adapter = ports.git;
    await adapter.commitEmptyStart('start issue 78');

    await expect(adapter.pushBranchUpstream(branch)).rejects.toThrow();
    expect(
      execFileSync(
        'git',
        [
          '--git-dir',
          remote,
          'rev-parse',
          `refs/heads/${branch}`,
        ],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe(competingOid);
  });

  it('refuses to roll back a local branch that moved after bootstrap', async () => {
    const { git, repo } = realGitRepo();
    git(['checkout', '-b', 'plan-loop/issue-78']);
    const expectedOid = git(['rev-parse', 'HEAD']);
    writeFileSync(path.join(repo, 'moved.txt'), 'moved\n');
    git(['add', 'moved.txt']);
    git(['commit', '-m', 'concurrent move']);

    await expect(
      createRealAppBootstrapPorts(repo).rollbackCreatedBranch(
        'plan-loop/issue-78',
        expectedOid,
      ),
    ).rejects.toThrow();
    expect(git(['rev-parse', 'refs/heads/plan-loop/issue-78'])).not.toBe(
      expectedOid,
    );
  });

  it('rejects staged app-state files even though unstaged app state is ignored', async () => {
    const { repo, git } = realGitRepo();
    mkdirSync(path.join(repo, '.agent-terminal'), { recursive: true });
    writeFileSync(path.join(repo, '.agent-terminal', 'capture.txt'), 'secret\n');
    git(['add', '.agent-terminal/capture.txt']);

    expect(await createRealAppBootstrapPorts(repo).git.isCleanTree()).toBe(
      false,
    );
  });

  it('creates an empty-tree commit without consuming a concurrently staged index', async () => {
    const { repo, git } = realGitRepo();
    git(['checkout', '-b', 'plan-loop/issue-78']);
    mkdirSync(path.join(repo, '.agent-terminal'), { recursive: true });
    writeFileSync(path.join(repo, '.agent-terminal', 'capture.txt'), 'secret\n');
    git(['add', '.agent-terminal/capture.txt']);

    await createRealAppBootstrapPorts(repo).git.commitEmptyStart(
      'start issue',
    );

    expect(() =>
      git(['show', 'HEAD:.agent-terminal/capture.txt']),
    ).toThrow();
    expect(git(['diff', '--cached', '--name-only'])).toBe(
      '.agent-terminal/capture.txt',
    );
  });
});
