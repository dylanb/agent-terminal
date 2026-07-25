import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGitHubRepositorySource,
  matchesGitHubRepositoryUrl,
  resolveGitHubRepository,
  validGitHubRepositorySelector,
  type GitHubRepositoryIdentity,
} from '../../src/main/githubRepository';
import { createRealAppBootstrapPorts } from '../../src/main/appBootstrapPorts';

const cleanup: string[] = [];
const originalPath = process.env.PATH;
const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
const originalAttempts = process.env.FAKE_ATTEMPTS;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
  if (originalAttempts === undefined) delete process.env.FAKE_ATTEMPTS;
  else process.env.FAKE_ATTEMPTS = originalAttempts;
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

const repository: GitHubRepositoryIdentity = {
  selector: 'github.com/owner/repository',
  owner: 'owner',
  name: 'repository',
  defaultBranch: 'main',
};

function fakeGitHub(bin: string): void {
  writeFileSync(
    join(bin, 'gh'),
    '#!/usr/bin/env bash\n' +
      'for a in "$@"; do if [ "$a" = "--jq" ]; then jq_next=1; elif [ -n "$jq_next" ]; then jq_filter=$a; jq_next=; fi; done\n' +
      'if [ "$jq_filter" = ".defaultBranchRef.name" ]; then printf \'%s\\n\' main; exit 0; fi\n' +
      'printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'\n',
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
}

function echoingGitHub(bin: string): void {
  writeFileSync(
    join(bin, 'gh'),
    '#!/usr/bin/env bash\n' +
      'selector=$3\n' +
      'host=${selector%%/*}\n' +
      'nameWithOwner=${selector#*/}\n' +
      'for a in "$@"; do if [ "$a" = "--jq" ]; then jq_next=1; elif [ -n "$jq_next" ]; then jq_filter=$a; jq_next=; fi; done\n' +
      'if [ "$jq_filter" = ".defaultBranchRef.name" ]; then printf \'%s\\n\' main; exit 0; fi\n' +
      'printf \'{"nameWithOwner":"%s","url":"https://%s/%s","defaultBranchRef":{"name":"main"}}\\n\' "$nameWithOwner" "$host" "$nameWithOwner"\n',
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
}

describe('GitHub repository identity', () => {
  it('resolves on a later attempt after a transient failure', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'github-repository-retry-'));
    const bin = mkdtempSync(join(tmpdir(), 'github-repository-retry-bin-'));
    cleanup.push(repo, bin);
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync(
      'git',
      ['remote', 'add', 'origin', 'https://github.com/owner/repository.git'],
      { cwd: repo },
    );
    const attempts = join(bin, 'attempts');
    writeFileSync(
      join(bin, 'gh'),
      '#!/usr/bin/env bash\n' +
        'printf x >> "$FAKE_ATTEMPTS"\n' +
        'if [ "$(wc -c < "$FAKE_ATTEMPTS")" -le 1 ]; then echo "auth required" >&2; exit 4; fi\n' +
        'printf \'%s\\n\' \'{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}\'\n',
      { mode: 0o755 },
    );
    writeFileSync(attempts, '');
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    process.env.FAKE_ATTEMPTS = attempts;

    const source = createGitHubRepositorySource(repo);
    await expect(source.resolve()).rejects.toThrow();

    await expect(source.resolve()).resolves.toMatchObject({
      selector: 'github.com/owner/repository',
    });
  });

  // `git config --get-all` exits 1 for an unset key and non-1 for a real problem (unreadable or
  // unparsable config). Collapsing both to "no values" reports a broken config as "there is no origin".
  it('tells an unset origin apart from a config it could not read', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'github-repository-badconfig-'));
    const bin = mkdtempSync(join(tmpdir(), 'github-repository-badconfig-bin-'));
    cleanup.push(repo, bin);
    execFileSync('git', ['init'], { cwd: repo });
    writeFileSync(
      join(bin, 'git'),
      '#!/usr/bin/env bash\nif [ "$1" = "config" ]; then exit 3; fi\nexit 0\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;

    await expect(resolveGitHubRepository(repo)).rejects.toThrow(
      /origin resolution failed/i,
    );
  });

  it('names a non-JSON repository lookup rather than leaking the parser error', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'github-repository-nonjson-'));
    const bin = mkdtempSync(join(tmpdir(), 'github-repository-nonjson-bin-'));
    cleanup.push(repo, bin);
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync(
      'git',
      ['remote', 'add', 'origin', 'https://github.com/owner/repository.git'],
      { cwd: repo },
    );
    writeFileSync(
      join(bin, 'gh'),
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "A new release of gh is available"\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;

    await expect(resolveGitHubRepository(repo)).rejects.toThrow(
      /invalid repository identity/i,
    );
  });

  it('names the repository the operations contact, not a rewritten one', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'github-repository-rewrite-'));
    const bin = mkdtempSync(join(tmpdir(), 'github-repository-rewrite-bin-'));
    cleanup.push(repo, bin);
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: repo });
    };
    git(['init']);
    git(['remote', 'add', 'origin', 'https://github.com/owner/repository.git']);
    // The remote operations read `remote.origin.url` straight out of config and hand the raw string
    // to an isolated git dir that never loads this rewrite, so an identity taken from the rewritten
    // value names a repository no operation will reach.
    git([
      'config',
      '--local',
      'url.https://github.com/attacker/other.git.insteadOf',
      'https://github.com/owner/repository.git',
    ]);
    echoingGitHub(bin);

    const resolved = await resolveGitHubRepository(repo);
    expect(resolved.selector).toBe('github.com/owner/repository');
    expect(resolved.fetchUrl).toBe('https://github.com/owner/repository.git');
    expect(resolved.pushUrl).toBe('https://github.com/owner/repository.git');
  });

  it('accepts only a canonical HTTPS URL for the expected repository resource', () => {
    expect(
      matchesGitHubRepositoryUrl(
        'https://github.com/owner/repository/pull/42',
        repository,
        'pull',
        42,
      ),
    ).toBe(true);

    for (const url of [
      'http://github.com/owner/repository/pull/42',
      'https://user@github.com/owner/repository/pull/42',
      'https://github.com:8443/owner/repository/pull/42',
      'https://github.com/owner/repository/pull/42?redirect=1',
      'https://github.com/owner/repository/pull/42#fragment',
      'https://github.com/other/repository/pull/42',
      'https://github.com/owner/repository/pull/43',
    ]) {
      expect(
        matchesGitHubRepositoryUrl(url, repository, 'pull', 42),
      ).toBe(false);
    }
  });

  it('rejects dot segments as repository selector identities', () => {
    expect(
      validGitHubRepositorySelector('github.com/owner/repository'),
    ).toBe(true);
    expect(validGitHubRepositorySelector('github.com/./repository')).toBe(
      false,
    );
    expect(validGitHubRepositorySelector('github.com/../repository')).toBe(
      false,
    );
  });

  it('rejects an origin whose push target names a different repository', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'github-repository-'));
    const bin = mkdtempSync(join(tmpdir(), 'github-repository-bin-'));
    cleanup.push(repo, bin);
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: repo });
    };
    git(['init']);
    git([
      'remote',
      'add',
      'origin',
      'https://github.com/owner/repository.git',
    ]);
    git([
      'remote',
      'set-url',
      '--add',
      '--push',
      'origin',
      'https://github.com/attacker/other.git',
    ]);
    fakeGitHub(bin);

    await expect(resolveGitHubRepository(repo)).rejects.toThrow(
      /origin repository/i,
    );
  });

  it('rejects an origin URL carrying embedded credentials', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'github-repository-credentials-'));
    const bin = mkdtempSync(join(tmpdir(), 'github-repository-credentials-bin-'));
    cleanup.push(repo, bin);
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync(
      'git',
      [
        'remote',
        'add',
        'origin',
        'https://token@github.com/owner/repository.git',
      ],
      { cwd: repo },
    );
    fakeGitHub(bin);

    await expect(resolveGitHubRepository(repo)).rejects.toThrow(
      /invalid origin repository/i,
    );
  });

  it('rejects multiple push targets even when they name the same repository', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'github-repository-ambiguous-'));
    const bin = mkdtempSync(join(tmpdir(), 'github-repository-ambiguous-bin-'));
    cleanup.push(repo, bin);
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: repo });
    };
    git(['init']);
    git([
      'remote',
      'add',
      'origin',
      'https://github.com/owner/repository.git',
    ]);
    git([
      'remote',
      'set-url',
      '--add',
      '--push',
      'origin',
      'https://github.com/owner/repository.git',
    ]);
    git([
      'remote',
      'set-url',
      '--add',
      '--push',
      'origin',
      'git@github.com:owner/repository.git',
    ]);
    fakeGitHub(bin);

    await expect(resolveGitHubRepository(repo)).rejects.toThrow(
      /origin repository targets/i,
    );
  });

  it('does not let a later repository-local insteadOf rule redirect exact branch deletion', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'github-repository-rewrite-'));
    const bin = mkdtempSync(join(tmpdir(), 'github-repository-rewrite-bin-'));
    const trustedRoot = mkdtempSync(join(tmpdir(), 'github-repository-trusted-'));
    const trusted = join(trustedRoot, 'owner', 'repository.git');
    const attacker = mkdtempSync(join(tmpdir(), 'github-repository-attacker-'));
    const globalConfig = join(trustedRoot, 'global.gitconfig');
    cleanup.push(repo, bin, trustedRoot, attacker);
    mkdirSync(join(trustedRoot, 'owner'), { recursive: true });
    execFileSync('git', ['init', '--bare', trusted]);
    execFileSync('git', ['init', '--bare', attacker]);
    const git = (args: string[]): string =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
      }).trim();
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Bootstrap Test']);
    git(['config', 'user.email', 'bootstrap@example.test']);
    writeFileSync(join(repo, 'README.md'), 'base\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'base']);
    git([
      'remote',
      'add',
      'origin',
      'https://github.com/owner/repository.git',
    ]);
    git(['push', trusted, 'main:refs/heads/main']);
    git(['push', attacker, 'main:refs/heads/main']);
    fakeGitHub(bin);
    const resolved = await resolveGitHubRepository(repo);
    const ports = createRealAppBootstrapPorts(repo);
    await expect(ports.git.resolveBaseBranch()).resolves.toBe('main');
    execFileSync(
      'git',
      [
        'config',
        '--file',
        globalConfig,
        `url.file://${trustedRoot}/.insteadOf`,
        'https://github.com/',
      ],
    );
    process.env.GIT_CONFIG_GLOBAL = globalConfig;

    // The branch the rollback must delete is one this port owns, created and pushed through it.
    await ports.git.createBranchFromBase('plan-loop/issue-78', 'main');
    const expectedOid = await ports.git.commitEmptyStart('[skip ci] start work on #78');
    await ports.git.pushBranchUpstream('plan-loop/issue-78', expectedOid);
    execFileSync('git', [
      '--git-dir',
      attacker,
      'update-ref',
      'refs/heads/plan-loop/issue-78',
      execFileSync('git', ['--git-dir', attacker, 'rev-parse', 'refs/heads/main'], {
        encoding: 'utf8',
      }).trim(),
    ]);
    const attackerOid = execFileSync(
      'git',
      ['--git-dir', attacker, 'rev-parse', 'refs/heads/plan-loop/issue-78'],
      { encoding: 'utf8' },
    ).trim();

    // Only now does the repository claim that origin's push URL is the attacker's.
    git([
      'config',
      `url.file://${attacker}.insteadOf`,
      resolved.pushUrl,
    ]);

    await ports.git.rollbackCreatedBranch(
      'plan-loop/issue-78',
      expectedOid,
    );

    expect(() =>
      execFileSync(
        'git',
        [
          '--git-dir',
          trusted,
          'rev-parse',
          'refs/heads/plan-loop/issue-78',
        ],
        { encoding: 'utf8' },
      ),
    ).toThrow();
    expect(
      execFileSync(
        'git',
        [
          '--git-dir',
          attacker,
          'rev-parse',
          'refs/heads/plan-loop/issue-78',
        ],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe(attackerOid);
  });

  it('fetches and pushes only through the isolated repository identity after a local insteadOf rewrite', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'github-repository-transfer-'));
    const bin = mkdtempSync(join(tmpdir(), 'github-repository-transfer-bin-'));
    const trustedRoot = mkdtempSync(join(tmpdir(), 'github-transfer-trusted-'));
    const trusted = join(trustedRoot, 'owner', 'repository.git');
    const attacker = mkdtempSync(join(tmpdir(), 'github-transfer-attacker-'));
    const trustedWork = mkdtempSync(join(tmpdir(), 'github-transfer-trusted-work-'));
    const attackerWork = mkdtempSync(join(tmpdir(), 'github-transfer-attacker-work-'));
    const globalConfig = join(trustedRoot, 'global.gitconfig');
    cleanup.push(
      repo,
      bin,
      trustedRoot,
      attacker,
      trustedWork,
      attackerWork,
    );
    mkdirSync(join(trustedRoot, 'owner'), { recursive: true });
    execFileSync('git', ['init', '--bare', trusted]);
    execFileSync('git', ['init', '--bare', attacker]);
    const seed = (work: string, remote: string, content: string): string => {
      const git = (args: string[]): string =>
        execFileSync('git', args, {
          cwd: work,
          encoding: 'utf8',
        }).trim();
      git(['init', '-b', 'main']);
      git(['config', 'user.name', 'Bootstrap Test']);
      git(['config', 'user.email', 'bootstrap@example.test']);
      writeFileSync(join(work, 'README.md'), `${content}\n`);
      git(['add', 'README.md']);
      git(['commit', '-m', content]);
      git(['push', remote, 'main:refs/heads/main']);
      return git(['rev-parse', 'HEAD']);
    };
    const trustedBase = seed(trustedWork, trusted, 'trusted');
    seed(attackerWork, attacker, 'attacker');
    const git = (args: string[]): string =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
      }).trim();
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Bootstrap Test']);
    git(['config', 'user.email', 'bootstrap@example.test']);
    git([
      'remote',
      'add',
      'origin',
      'https://github.com/owner/repository.git',
    ]);
    fakeGitHub(bin);
    const resolved = await resolveGitHubRepository(repo);
    const ports = createRealAppBootstrapPorts(repo);
    await expect(ports.git.resolveBaseBranch()).resolves.toBe('main');
    execFileSync(
      'git',
      [
        'config',
        '--file',
        globalConfig,
        `url.file://${trustedRoot}/.insteadOf`,
        'https://github.com/',
      ],
    );
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    git([
      'config',
      `url.file://${attacker}.insteadOf`,
      resolved.pushUrl,
    ]);

    const adapter = ports.git;
    await adapter.createBranchFromBase('plan-loop/issue-78', 'main');
    expect(git(['rev-parse', 'plan-loop/issue-78'])).toBe(trustedBase);
    const pushed = await adapter.commitEmptyStart('start issue 78');
    await adapter.pushBranchUpstream('plan-loop/issue-78', pushed);

    expect(
      execFileSync(
        'git',
        [
          '--git-dir',
          trusted,
          'rev-parse',
          'refs/heads/plan-loop/issue-78',
        ],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe(pushed);
    expect(() =>
      execFileSync('git', [
        '--git-dir',
        attacker,
        'rev-parse',
        'refs/heads/plan-loop/issue-78',
      ]),
    ).toThrow();
  });
});
