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
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_ASKPASS',
  'GIT_PROXY_COMMAND',
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
  // Both halves of one policy: the value-injecting channels are dropped, the two vars that merely NAME
  // the user's own config files are passed through — widening the scrub to all of GIT_CONFIG_* breaks
  // every user with a non-default global config, and has shipped once already.
  it('drops inherited GIT_CONFIG_* injection while preserving the user config files it names', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'app-command-gitconfig-'));
    cleanup.push(bin);
    writeFileSync(
      join(bin, 'git'),
      '#!/usr/bin/env bash\nprintf \'%s|%s|%s|%s|%s|%s\\n\' "${GIT_CONFIG_COUNT-unset}" "${GIT_CONFIG_KEY_0-unset}" "${GIT_CONFIG_VALUE_0-unset}" "${GIT_CONFIG_PARAMETERS-unset}" "${GIT_CONFIG_GLOBAL-unset}" "${GIT_CONFIG_SYSTEM-unset}"\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'url.https://evil.example/.insteadOf';
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/';
    // git's own command-line-precedence channel — the one `-c` serializes into — so it reinstates the
    // same url.*.insteadOf redirect the numbered pairs do.
    process.env.GIT_CONFIG_PARAMETERS =
      "'url.https://evil.example/.insteadOf'='https://github.com/'";
    process.env.GIT_CONFIG_GLOBAL = '/home/operator/.gitconfig';
    process.env.GIT_CONFIG_SYSTEM = '/etc/gitconfig';

    await expect(runAppCommand('git', [], bin)).resolves.toBe(
      'unset|unset|unset|unset|/home/operator/.gitconfig|/etc/gitconfig\n',
    );
  });

  // GIT_SSH_COMMAND takes precedence over core.sshCommand INCLUDING an explicit `-c`, so while it is set
  // the `-c core.sshCommand=ssh` neutralizer every bootstrap operation carries is inert and the ambient
  // value is the program that speaks to the remote (CWE-15, CWE-78).
  it('drops the transport commands that would override the ssh neutralizer', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'app-command-transport-'));
    cleanup.push(bin);
    writeFileSync(
      join(bin, 'git'),
      '#!/usr/bin/env bash\nprintf \'%s|%s|%s|%s\\n\' "${GIT_SSH_COMMAND-unset}" "${GIT_SSH-unset}" "${GIT_ASKPASS-unset}" "${GIT_PROXY_COMMAND-unset}"\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    process.env.GIT_SSH_COMMAND = 'sh -c "id > /tmp/pwned"';
    process.env.GIT_SSH = '/tmp/evil-ssh';
    process.env.GIT_ASKPASS = '/tmp/evil-askpass';
    process.env.GIT_PROXY_COMMAND = '/tmp/evil-proxy';

    await expect(runAppCommand('git', [], bin)).resolves.toBe(
      'unset|unset|unset|unset\n',
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
