import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAppGitRemote,
  runAppCommand,
} from '../../src/main/appCommand';

const cleanup: string[] = [];
const originalPath = process.env.PATH;
const originalRepository = process.env.GH_REPO;
const originalGitDir = process.env.GIT_DIR;
const originalGitWorkTree = process.env.GIT_WORK_TREE;
const gitConfigVars = [
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
];
const originalGitConfig = gitConfigVars.map((k) => [k, process.env[k]] as const);

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalRepository === undefined) delete process.env.GH_REPO;
  else process.env.GH_REPO = originalRepository;
  if (originalGitDir === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = originalGitDir;
  if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
  else process.env.GIT_WORK_TREE = originalGitWorkTree;
  for (const [key, value] of originalGitConfig) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (cleanup.length > 0) {
    rmSync(cleanup.pop()!, { recursive: true, force: true });
  }
});

describe('app command boundary', () => {
  it('confines Git commands to cwd despite inherited repository-selection variables', async () => {
    const intended = mkdtempSync(join(tmpdir(), 'app-command-intended-'));
    const ambient = mkdtempSync(join(tmpdir(), 'app-command-ambient-'));
    cleanup.push(intended, ambient);
    const seed = (repo: string, content: string): string => {
      const git = (args: string[]): string =>
        execFileSync('git', args, {
          cwd: repo,
          encoding: 'utf8',
        }).trim();
      git(['init', '-b', 'main']);
      git(['config', 'user.name', 'Command Test']);
      git(['config', 'user.email', 'command@example.test']);
      writeFileSync(join(repo, 'README.md'), `${content}\n`);
      git(['add', 'README.md']);
      git(['commit', '-m', content]);
      return git(['rev-parse', 'HEAD']);
    };
    const intendedOid = seed(intended, 'intended');
    const ambientOid = seed(ambient, 'ambient');
    expect(ambientOid).not.toBe(intendedOid);
    process.env.GIT_DIR = join(ambient, '.git');
    process.env.GIT_WORK_TREE = ambient;

    await expect(
      runAppCommand('git', ['rev-parse', 'HEAD'], intended),
    ).resolves.toBe(`${intendedOid}\n`);
  });

  it('removes inherited GH_REPO and forwards optional stdin without a shell', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'app-command-'));
    cleanup.push(bin);
    writeFileSync(
      join(bin, 'gh'),
      '#!/usr/bin/env bash\nprintf \'%s|\' "${GH_REPO-unset}"\ncat\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    process.env.GH_REPO = 'attacker/other';

    await expect(
      runAppCommand('gh', ['ignored'], bin, 'body\n'),
    ).resolves.toBe('unset|body\n');
  });

  it('surfaces only the command and exit classification', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'app-command-error-'));
    cleanup.push(bin);
    writeFileSync(
      join(bin, 'gh'),
      '#!/usr/bin/env bash\necho "secret stderr" >&2\nexit 7\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;

    await expect(runAppCommand('gh', [], bin)).rejects.toThrow(
      'gh command failed (exit 7)',
    );
  });

  it('reads the object of the named ref, not of another ref the pattern matches', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'app-command-read-repo-'));
    const remote = mkdtempSync(join(tmpdir(), 'app-command-read-remote-'));
    cleanup.push(repo, remote);
    const git = (args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Command Test']);
    git(['config', 'user.email', 'command@example.test']);
    execFileSync('git', ['init', '--bare'], { cwd: remote });
    writeFileSync(join(repo, 'README.md'), 'decoy\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'decoy']);
    const decoyOid = git(['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'README.md'), 'real\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'real']);
    const realOid = git(['rev-parse', 'HEAD']);
    expect(decoyOid).not.toBe(realOid);
    // `git ls-remote <pattern>` matches the tail of a ref name on a slash boundary, and this decoy
    // sorts ahead of the real ref.
    git([
      'push',
      remote,
      `${decoyOid}:refs/heads/decoy/refs/heads/plan-loop/issue-78`,
      `${realOid}:refs/heads/plan-loop/issue-78`,
    ]);

    await expect(
      createAppGitRemote(repo).readRef(remote, 'refs/heads/plan-loop/issue-78'),
    ).resolves.toBe(realOid);
  });

  it('reports a ref absent when only another ref the pattern matches exists', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'app-command-absent-repo-'));
    const remote = mkdtempSync(join(tmpdir(), 'app-command-absent-remote-'));
    cleanup.push(repo, remote);
    const git = (args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Command Test']);
    git(['config', 'user.email', 'command@example.test']);
    execFileSync('git', ['init', '--bare'], { cwd: remote });
    writeFileSync(join(repo, 'README.md'), 'decoy\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'decoy']);
    git([
      'push',
      remote,
      'HEAD:refs/heads/decoy/refs/heads/plan-loop/issue-78',
    ]);

    await expect(
      createAppGitRemote(repo).readRef(remote, 'refs/heads/plan-loop/issue-78'),
    ).resolves.toBeNull();
  });

  it('does not delete a remote ref that moved past the expected object', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'app-command-delete-repo-'));
    const remote = mkdtempSync(join(tmpdir(), 'app-command-delete-remote-'));
    cleanup.push(repo, remote);
    const git = (args: string[]): string =>
      execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
      }).trim();
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Command Test']);
    git(['config', 'user.email', 'command@example.test']);
    execFileSync('git', ['init', '--bare'], { cwd: remote });
    writeFileSync(join(repo, 'README.md'), 'old\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'old']);
    const expectedOid = git(['rev-parse', 'HEAD']);
    git(['push', remote, 'HEAD:refs/heads/plan-loop/issue-78']);
    writeFileSync(join(repo, 'README.md'), 'new\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'new']);
    const movedOid = git(['rev-parse', 'HEAD']);
    git([
      'push',
      '--force',
      remote,
      'HEAD:refs/heads/plan-loop/issue-78',
    ]);

    await expect(
      createAppGitRemote(repo).deleteRef(
        remote,
        'refs/heads/plan-loop/issue-78',
        expectedOid,
      ),
    ).rejects.toThrow();
    expect(
      execFileSync(
        'git',
        [
          '--git-dir',
          remote,
          'rev-parse',
          'refs/heads/plan-loop/issue-78',
        ],
        { encoding: 'utf8' },
      ).trim(),
    ).toBe(movedOid);
  });
});

describe('app command environment neutralization', () => {
  it('drops inherited GIT_CONFIG_* injection, which can rewrite any remote URL', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'app-command-gitconfig-'));
    cleanup.push(bin);
    writeFileSync(
      join(bin, 'git'),
      '#!/usr/bin/env bash\nprintf \'%s|%s|%s\\n\' "${GIT_CONFIG_COUNT-unset}" "${GIT_CONFIG_KEY_0-unset}" "${GIT_CONFIG_VALUE_0-unset}"\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'url.https://evil.example/.insteadOf';
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/';

    await expect(runAppCommand('git', [], bin)).resolves.toBe(
      'unset|unset|unset\n',
    );
  });
});

describe('app command failure classification', () => {
  it('names an output-limit overrun rather than reporting a timeout', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'app-command-maxbuffer-'));
    cleanup.push(bin);
    // execFile kills the child on a maxBuffer overrun and sets `killed`, which is the same flag a real
    // timeout sets — so a classification keyed on `killed` alone sends the operator hunting a hang.
    writeFileSync(
      join(bin, 'gh'),
      '#!/usr/bin/env bash\nhead -c 2000000 /dev/zero | tr "\\0" "x"\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;

    await expect(runAppCommand('gh', [], bin)).rejects.toThrow(/output limit/i);
  });

  it('names a missing executable rather than reporting a timeout', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'app-command-missing-'));
    cleanup.push(bin);
    process.env.PATH = bin;

    await expect(runAppCommand('gh', [], bin)).rejects.toThrow(/could not start/i);
  });
});
