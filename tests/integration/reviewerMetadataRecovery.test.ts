import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ensureRunReviewers } from '../../src/main/runReviewers';

it.skipIf(process.getuid?.() === 0).each(['git-file', 'backlink', 'commondir', 'agents-search', 'git-search', 'run-search'] as const)('offered repair restores installation after %s permission failure', (fault) => {
  const root = mkdtempSync(join(tmpdir(), "metadata repair's-"));
  const repo = join(root, 'main');
  const work = join(root, 'work');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-qm', 'seed']);
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', work], { stdio: 'pipe' });
  const charter = join(root, 'charter.md');
  writeFileSync(charter, 'Required reviewer.\n');
  const reviewer = { loop: 'custom', persona: 'review-result', charter, tools: ['Read'] };
  const gitDir = readFileSync(join(work, '.git'), 'utf8').trim().replace(/^gitdir: /, '');
  const directoryFault = fault === 'agents-search' || fault === 'git-search' || fault === 'run-search';
  const obstruction = fault === 'git-search' ? gitDir : fault === 'run-search' ? work : fault === 'git-file' ? join(work, '.git') : fault === 'agents-search' ? join(work, '.claude', 'agents') : join(gitDir, fault === 'backlink' ? 'gitdir' : 'commondir');
  if (fault === 'agents-search') mkdirSync(obstruction, { recursive: true });
  chmodSync(obstruction, directoryFault ? 0o600 : 0o200);
  try {
    const failed = ensureRunReviewers(work, [reviewer], '');
    expect(failed.wrote).toEqual([]);
    const notice = failed.problems.join('\n');
    expect.soft(notice).toContain(reviewer.persona);
    expect.soft(notice).toContain(obstruction);
    expect.soft(notice).not.toContain('not inside');
    const command = /```sh\n([\s\S]*?)```/.exec(notice)?.[1];
    expect(command).toBeDefined();
    execFileSync('/bin/sh', ['-c', command!], { cwd: tmpdir(), stdio: 'pipe' });
    const retried = ensureRunReviewers(work, [reviewer], '');
    expect(retried.problems).toEqual([]);
    expect(retried.wrote).toHaveLength(1);
    expect(readFileSync(retried.wrote[0], 'utf8')).toContain('Required reviewer.');
  } finally {
    chmodSync(obstruction, directoryFault ? 0o700 : 0o600);
    rmSync(root, { recursive: true, force: true });
  }
});
