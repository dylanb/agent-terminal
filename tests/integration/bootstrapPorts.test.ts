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
  createRealBootstrapGit,
  type AppBootstrapConflictResources,
} from '../../src/main/bootstrapPorts';

const cleanup: string[] = [];

afterEach(() => {
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
  it('never offers or closes a fork pull request that reuses the target branch name', async () => {
    let closedSameRepositoryPullRequest = false;
    const closed: Array<{ repository: string; pullRequest: number }> = [];
    const resources: AppBootstrapConflictResources = {
      localObjectId: async () => null,
      remoteObjectId: async () => null,
      repositoryIdentity: async () => ({
        selector: 'github.com/owner/repository',
        owner: 'owner',
        name: 'repository',
      }),
      openPullRequests: async () => [
        ...(
          closedSameRepositoryPullRequest
            ? []
            : [
                {
                  number: 41,
                  crossRepository: false,
                  headOwner: 'owner',
                  headRepository: 'repository',
                },
              ]
        ),
        {
          number: 99,
          crossRepository: true,
          headOwner: 'contributor',
          headRepository: 'fork',
        },
      ],
      closePullRequest: async (repository, pullRequest) => {
        closed.push({ repository, pullRequest });
        closedSameRepositoryPullRequest = true;
      },
      currentBranch: async () => null,
      detach: async () => {},
      deleteLocalBranch: async () => {},
      deleteRemoteBranch: async () => {},
    };

    const conflicts = createAppBootstrapConflicts(resources);
    const target = await conflicts.inspect('plan-loop/issue-78');

    expect(target).toMatchObject({
      repository: 'github.com/owner/repository',
      pullRequests: [41],
    });
    await conflicts.wipe(target);
    expect(closed).toEqual([
      {
        repository: 'github.com/owner/repository',
        pullRequest: 41,
      },
    ]);
  });

  it('detaches a checked-out target branch before conditionally deleting its exact ref', async () => {
    const { git } = realGitRepo();
    git(['checkout', '-b', 'plan-loop/issue-78']);
    const oid = git(['rev-parse', 'HEAD']);
    const resources: AppBootstrapConflictResources = {
      localObjectId: async (branch) => {
        try {
          return git(['rev-parse', '--verify', `refs/heads/${branch}`]);
        } catch {
          return null;
        }
      },
      remoteObjectId: async () => null,
      repositoryIdentity: async () => ({
        selector: 'github.com/owner/repository',
        owner: 'owner',
        name: 'repository',
      }),
      openPullRequests: async () => [],
      closePullRequest: async () => {},
      currentBranch: async () => git(['branch', '--show-current']) || null,
      detach: async (at) => {
        git(['checkout', '--detach', at]);
      },
      deleteLocalBranch: async (branch, expectedOid) => {
        git(['update-ref', '-d', `refs/heads/${branch}`, expectedOid]);
      },
      deleteRemoteBranch: async () => {},
    };

    const conflicts = createAppBootstrapConflicts(resources);
    const target = await conflicts.inspect('plan-loop/issue-78');
    await conflicts.wipe(target);

    expect(target.localOid).toBe(oid);
    expect(git(['branch', '--show-current'])).toBe('');
    expect(() =>
      git(['rev-parse', '--verify', 'refs/heads/plan-loop/issue-78']),
    ).toThrow();
  });
});

describe('bootstrap start commit', () => {
  it('rejects staged app-state files even though unstaged app state is ignored', async () => {
    const { repo, git } = realGitRepo();
    mkdirSync(path.join(repo, '.agent-terminal'), { recursive: true });
    writeFileSync(path.join(repo, '.agent-terminal', 'capture.txt'), 'secret\n');
    git(['add', '.agent-terminal/capture.txt']);

    expect(await createRealBootstrapGit(repo).isCleanTree()).toBe(false);
  });

  it('creates an empty-tree commit without consuming a concurrently staged index', async () => {
    const { repo, git } = realGitRepo();
    git(['checkout', '-b', 'plan-loop/issue-78']);
    mkdirSync(path.join(repo, '.agent-terminal'), { recursive: true });
    writeFileSync(path.join(repo, '.agent-terminal', 'capture.txt'), 'secret\n');
    git(['add', '.agent-terminal/capture.txt']);

    await createRealBootstrapGit(repo).commitEmptyStart('start issue');

    expect(() =>
      git(['show', 'HEAD:.agent-terminal/capture.txt']),
    ).toThrow();
    expect(git(['diff', '--cached', '--name-only'])).toBe(
      '.agent-terminal/capture.txt',
    );
  });
});
