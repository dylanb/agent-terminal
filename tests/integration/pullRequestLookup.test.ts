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
      `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf '%s\\n' "$*" > '${argsLog}.view'; printf '%s\\n' '{"number":233,"url":"https://github.com/owner/repository/pull/233","headRefName":"plan-loop/issue-218","state":"OPEN","closingIssuesReferences":[{"number":218,"url":"https://github.com/owner/repository/issues/218"}],"isCrossRepository":false}'; exit 0; fi\n` +
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

describe('a pull request GitHub is asked about by number', () => {
  it('asks for every field the identity check reads, and reads them back', async () => {
    const { repo, argsLog } = seedRepoWithGh('[]');
    expect(await createRealPullRequestLookup(repo).pullRequest(233)).toEqual({ number: 233, branch: 'plan-loop/issue-218', state: 'OPEN', closingIssues: [218], closingTickets: [{ repo: 'owner/repository', number: 218 }], crossRepository: false });
    const fields = /--json (\S+)/.exec(readFileSync(`${argsLog}.view`, 'utf8'))?.[1].split(',') ?? [];
    expect(fields).toEqual(expect.arrayContaining(['number', 'url', 'headRefName', 'state', 'closingIssuesReferences', 'isCrossRepository', 'headRepository', 'headRepositoryOwner']));
  });
});

describe("a fork's pull request that also closes a ticket outside its base and head repositories (#304 AC 24)", () => {
  it('reads back the tickets it closes in origin and in its head repository, leaving the other one out', async () => {
    const { repo } = seedRepoWithGh('[]');
    const view = JSON.stringify({
      number: 41,
      url: 'https://github.com/owner/repository/pull/41',
      headRefName: 'feature/reviewed-change',
      state: 'OPEN',
      isCrossRepository: true,
      headRepository: { name: 'Fork' },
      headRepositoryOwner: { login: 'Contributor' },
      closingIssuesReferences: [
        { number: 176, url: 'https://github.com/owner/repository/issues/176' },
        { number: 177, url: 'https://github.com/contributor/fork/issues/177' },
        { number: 9, url: 'https://github.com/other-org/lib/issues/9' },
      ],
    });
    const bin = mkdtempSync(join(tmpdir(), 'pr-lookup-fork-bin-'));
    cleanup.push(bin);
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env bash\nif [ "$1" = "repo" ]; then printf '%s\\n' '${REPO_VIEW}'; exit 0; fi\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf '%s\\n' '${view}'; exit 0; fi\nexit 1\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    const pr = await createRealPullRequestLookup(repo, 'ignore').pullRequest(41);
    expect.soft(pr.closingIssues).toEqual([176]);
    expect.soft(pr.closingTickets).toEqual([
      { repo: 'owner/repository', number: 176 },
      { repo: 'contributor/fork', number: 177 },
    ]);
  });
});

describe("a ticket run's pull request that also closes an issue in another repository", () => {
  it('is refused as an invalid closing-issue identity, as before #304', async () => {
    const { repo } = seedRepoWithGh('[]');
    const view = JSON.stringify({
      number: 233,
      url: 'https://github.com/owner/repository/pull/233',
      headRefName: 'plan-loop/issue-218',
      state: 'OPEN',
      isCrossRepository: false,
      closingIssuesReferences: [
        { number: 218, url: 'https://github.com/owner/repository/issues/218' },
        { number: 9, url: 'https://github.com/other-org/lib/issues/9' },
      ],
    });
    const bin = mkdtempSync(join(tmpdir(), 'pr-lookup-foreign-bin-'));
    cleanup.push(bin);
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env bash\nif [ "$1" = "repo" ]; then printf '%s\\n' '${REPO_VIEW}'; exit 0; fi\nif [ "$1" = "pr" ] && [ "$2" = "view" ]; then printf '%s\\n' '${view}'; exit 0; fi\nexit 1\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${originalPath ?? ''}`;
    await expect(createRealPullRequestLookup(repo).pullRequest(233)).rejects.toThrow('invalid GitHub closing issue identity');
  });
});
