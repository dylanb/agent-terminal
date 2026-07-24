import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAppCommand } from '../../src/main/appCommand';

const cleanup: string[] = [];
const originalPath = process.env.PATH;
const originalRepository = process.env.GH_REPO;
const originalGitDir = process.env.GIT_DIR;
const originalGitWorkTree = process.env.GIT_WORK_TREE;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalRepository === undefined) delete process.env.GH_REPO;
  else process.env.GH_REPO = originalRepository;
  if (originalGitDir === undefined) delete process.env.GIT_DIR;
  else process.env.GIT_DIR = originalGitDir;
  if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
  else process.env.GIT_WORK_TREE = originalGitWorkTree;
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
});
