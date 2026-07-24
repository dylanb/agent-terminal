import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAppLoopBootstrap } from '../../src/main/appLoopBootstrap';
import { createRealAppBootstrapPorts } from '../../src/main/appBootstrapPorts';
import type { GitHubRepositoryIdentity } from '../../src/main/githubRepository';

const cleanup: string[] = [];
const originalPath = process.env.PATH;
const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
const repository: GitHubRepositoryIdentity = {
  selector: 'github.com/owner/repository',
  owner: 'owner',
  name: 'repository',
  defaultBranch: 'main',
};

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

describe('real app bootstrap conflict adapter', () => {
  it('refuses a mismatched pull-request identity before exposing a destructive target', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'bootstrap-conflict-identity-'));
    const bin = mkdtempSync(
      join(tmpdir(), 'bootstrap-conflict-identity-bin-'),
    );
    const remote = mkdtempSync(
      join(tmpdir(), 'bootstrap-conflict-identity-remote-'),
    );
    const configDir = mkdtempSync(
      join(tmpdir(), 'bootstrap-conflict-identity-config-'),
    );
    cleanup.push(repo, bin, remote, configDir);
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['init', '--bare'], { cwd: remote });
    execFileSync(
      'git',
      [
        'remote',
        'add',
        'origin',
        'https://github.com/owner/repository.git',
      ],
      { cwd: repo },
    );
    writeFileSync(
      join(bin, 'gh'),
      '#!/usr/bin/env bash\n' +
        'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
        'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf \'%s\\n\' \'[{"number":42,"url":"https://github.com/attacker/other/pull/42","headRefOid":"2222222222222222222222222222222222222222","isCrossRepository":false,"headRepository":{"name":"repository"},"headRepositoryOwner":{"login":"owner"}}]\'; exit 0; fi\n' +
        'exit 1\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;

    const ports = createRealAppBootstrapPorts(repo);
    await expect(ports.git.resolveBaseBranch()).resolves.toBe('main');
    execFileSync('git', [
      'config',
      '--file',
      join(configDir, 'gitconfig'),
      `url.file://${remote}/.insteadOf`,
      'https://github.com/owner/repository.git',
    ]);
    process.env.GIT_CONFIG_GLOBAL = join(configDir, 'gitconfig');

    await expect(
      ports.conflicts.inspect('plan-loop/issue-78'),
    ).rejects.toThrow(/mismatched identity/i);
  });

  it('does not close a pull request whose head moved after inspection', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'bootstrap-conflict-github-'));
    const bin = mkdtempSync(join(tmpdir(), 'bootstrap-conflict-github-bin-'));
    const remote = mkdtempSync(join(tmpdir(), 'bootstrap-conflict-remote-'));
    const marker = join(bin, 'closed');
    cleanup.push(repo, bin, remote);
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['init', '--bare'], { cwd: remote });
    execFileSync(
      'git',
      [
        'remote',
        'add',
        'origin',
        'https://github.com/owner/repository.git',
      ],
      { cwd: repo },
    );
    writeFileSync(
      join(bin, 'gh'),
      '#!/usr/bin/env bash\n' +
        'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"Owner/Repository","url":"https://github.com/Owner/Repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
        'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf \'%s\\n\' \'[{"number":42,"url":"https://github.com/Owner/Repository/pull/42","headRefOid":"2222222222222222222222222222222222222222","isCrossRepository":false,"headRepository":{"name":"Repository"},"headRepositoryOwner":{"login":"Owner"}}]\'; exit 0; fi\n' +
        'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf \'%s\\n\' \'{"number":42,"url":"https://github.com/Owner/Repository/pull/42","state":"OPEN","headRefOid":"6666666666666666666666666666666666666666","isCrossRepository":false,"headRefName":"plan-loop/issue-78","headRepository":{"name":"Repository"},"headRepositoryOwner":{"login":"Owner"}}\'; exit 0; fi\n' +
        `if [ "$1" = "pr" ] && [ "$2" = "close" ]; then touch ${JSON.stringify(marker)}; exit 0; fi\n` +
        'exit 1\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;

    const ports = createRealAppBootstrapPorts(repo);
    await expect(ports.git.resolveBaseBranch()).resolves.toBe('main');
    const configDir = mkdtempSync(join(tmpdir(), 'bootstrap-conflict-config-'));
    const config = join(configDir, 'gitconfig');
    cleanup.push(configDir);
    execFileSync('git', [
      'config',
      '--file',
      config,
      `url.file://${remote}/.insteadOf`,
      'https://github.com/owner/repository.git',
    ]);
    process.env.GIT_CONFIG_GLOBAL = config;
    const conflicts = ports.conflicts;
    const target = await conflicts.inspect('plan-loop/issue-78');

    await expect(conflicts.wipe(target)).rejects.toThrow(
      /pull request changed before close/i,
    );
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects a draft-PR URL from another repository and rolls back before persistence or PR labels', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'bootstrap-pr-identity-'));
    const bin = mkdtempSync(join(tmpdir(), 'bootstrap-pr-identity-bin-'));
    const prLabelMarker = join(bin, 'pr-labelled');
    cleanup.push(repo, bin);
    writeFileSync(
      join(bin, 'gh'),
      '#!/usr/bin/env bash\n' +
        'if [ "$1" = "repo" ]; then printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'; exit 0; fi\n' +
        'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then printf \'%s\\n\' \'{"title":"Ticket 78","url":"https://github.com/owner/repository/issues/78"}\'; exit 0; fi\n' +
        'if [ "$1" = "issue" ] && [ "$2" = "edit" ]; then exit 0; fi\n' +
        'if [ "$1" = "pr" ] && [ "$2" = "create" ]; then printf \'%s\\n\' \'https://github.com/attacker/other/pull/4242\'; exit 0; fi\n' +
        `if [ "$1" = "pr" ] && [ "$2" = "edit" ]; then touch ${JSON.stringify(prLabelMarker)}; exit 0; fi\n` +
        'exit 1\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync(
      'git',
      [
        'remote',
        'add',
        'origin',
        'https://github.com/owner/repository.git',
      ],
      { cwd: repo },
    );
    const rollbackCreatedBranch = vi.fn(async () => {});
    const writeBootstrap = vi.fn();
    const ports = createRealAppBootstrapPorts(repo);

    const result = await runAppLoopBootstrap(
      {
        git: {
          isCleanTree: async () => true,
          resolveBaseBranch: async () => 'main',
          createBranchFromBase: async () => '3'.repeat(40),
          commitEmptyStart: async () => '4'.repeat(40),
          pushBranchUpstream: async () => {},
        },
        github: ports.github,
        conflicts: {
          inspect: async (branch) => ({
            repository: repository.selector,
            branch,
            localOid: null,
            remoteOid: null,
            pullRequests: [],
          }),
          wipe: async () => {},
        },
        rollbackCreatedBranch,
        writeBootstrap,
      },
      {
        issue: 78,
        spec: {
          origin: 'operator',
          branchTemplate: 'plan-loop/issue-{issue}',
          wipe: { mode: 'wipe-and-retry' },
          initialLabels: [
            { action: 'add', target: 'pr', label: 'agent-loop/active' },
          ],
        },
      },
    );

    expect(result).toEqual({
      kind: 'error',
      error: expect.stringMatching(/draft PR creation failed/i),
    });
    expect(rollbackCreatedBranch).toHaveBeenCalledWith(
      'plan-loop/issue-78',
      '4'.repeat(40),
    );
    expect(writeBootstrap).not.toHaveBeenCalled();
    expect(existsSync(prLabelMarker)).toBe(false);
  });
});
