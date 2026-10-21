import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRealPullRequestLookup } from '../../src/main/pullRequestLookup';

const cleanup: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true });
});

const REPO_VIEW = '{"nameWithOwner":"owner/repository","url":"https://github.com/owner/repository","defaultBranchRef":{"name":"main"}}';

function seedRepoWithGh(listJson: string): { repo: string; argsLog: string } {
  const repo = mkdtempSync(join(tmpdir(), 'pr-lookup-'));
  const bin = mkdtempSync(join(tmpdir(), 'pr-lookup-bin-'));
  cleanup.push(repo, bin);
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/repository.git'], { cwd: repo });
  const argsLog = join(bin, 'args');
  writeFileSync(
    join(bin, 'gh'),
    '#!/usr/bin/env bash\n' +
      `if [ "$1" = "repo" ]; then printf '%s\\n' '${REPO_VIEW}'; exit 0; fi\n` +
      `if [ "$1" = "pr" ] && [ "$2" = "list" ]; then printf '%s\\n' "$*" > '${argsLog}'; printf '%s\\n' '${listJson}'; exit 0; fi\n` +
      'exit 1\n',
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
  return { repo, argsLog };
}

describe('the open pull requests GitHub has for a branch', () => {
  it('asks GitHub for the branch’s open PRs in this repository and returns their numbers', async () => {
    const { repo, argsLog } = seedRepoWithGh('[{"number":233,"url":"https://github.com/owner/repository/pull/233","isCrossRepository":false}]');
    expect(await createRealPullRequestLookup(repo).openForBranch('plan-loop/issue-218')).toEqual([233]);
    const args = readFileSync(argsLog, 'utf8');
    expect(args).toContain('--head plan-loop/issue-218');
    expect(args).toContain('--state open');
    expect(args).toMatch(/--repo \S*owner\/repository\b/);
  });

  it('leaves out a fork’s PR and one whose URL belongs to another repository', async () => {
    const { repo } = seedRepoWithGh(
      '[{"number":233,"url":"https://github.com/owner/repository/pull/233","isCrossRepository":false},' +
        '{"number":999,"url":"https://github.com/contributor/fork/pull/999","isCrossRepository":true},' +
        '{"number":5,"url":"https://github.com/other/repo/pull/5","isCrossRepository":false}]',
    );
    expect(await createRealPullRequestLookup(repo).openForBranch('plan-loop/issue-218')).toEqual([233]);
  });

  it('refuses an answer that is not a list of pull requests', async () => {
    const { repo } = seedRepoWithGh('{"oops":true}');
    await expect(createRealPullRequestLookup(repo).openForBranch('plan-loop/issue-218')).rejects.toThrow();
  });
});
