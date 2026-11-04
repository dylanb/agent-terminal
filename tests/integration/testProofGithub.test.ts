import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import {
  hermeticPath,
  installTestProofGh,
  TEST_PROOF_GH_ORIGIN,
  type StandInPullRequest,
} from '../helpers/testProofGh';
import { createBranchPullRequests } from '../../src/main/testProofPorts';

const BRANCH = 'feature/proof';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const originalPath = process.env.PATH;
const MISSING = /not found|not installed|missing|absent|could not (start|run)/i;
const LOGGED_OUT = /log(ged)?[ -]?in|auth/i;

let git: GitRepoFixture;
let repo: string;
let scratch: string;
let tools: string;

const pr = (number: number, headRefOid: string, isCrossRepository = false): StandInPullRequest => ({
  number,
  headRefName: BRANCH,
  headRefOid,
  isCrossRepository,
});

function withGh(initial: Parameters<typeof installTestProofGh>[1]): void {
  const bin = join(scratch, 'gh-bin');
  installTestProofGh(bin, initial);
  process.env.PATH = `${bin}:${tools}`;
}

beforeEach(() => {
  git = createGitRepoFixture();
  repo = git.makeGitRepo('test-proof-github');
  git.git(repo, ['remote', 'add', 'origin', TEST_PROOF_GH_ORIGIN]);
  scratch = mkdtempSync(join(tmpdir(), 'test-proof-github-'));
  tools = hermeticPath(join(scratch, 'tools'), ['node', 'git']);
});

afterEach(() => {
  process.env.PATH = originalPath;
  rmSync(scratch, { recursive: true, force: true });
  git.cleanup();
});

describe('the proof PR-lookup adapter (stand-in gh)', () => {
  it('reads a branch with no open PR as none', async () => {
    withGh({ pullRequests: [] });
    expect(await createBranchPullRequests(repo).openFor(BRANCH)).toEqual({ kind: 'none' });
  });

  it('reads one same-repository PR as open, with its number and head SHA', async () => {
    withGh({ pullRequests: [pr(12, SHA_A)] });
    expect(await createBranchPullRequests(repo).openFor(BRANCH)).toEqual({ kind: 'open', number: 12, headSha: SHA_A });
  });

  it('reads two same-repository PRs as several, listing both', async () => {
    withGh({ pullRequests: [pr(12, SHA_A), pr(15, SHA_B)] });
    const found = await createBranchPullRequests(repo).openFor(BRANCH);
    expect(found.kind === 'several' ? { kind: found.kind, numbers: [...found.numbers].sort((a, b) => a - b) } : found).toEqual({
      kind: 'several',
      numbers: [12, 15],
    });
  });

  it('reads fork PRs only as fork', async () => {
    withGh({ pullRequests: [pr(21, SHA_C, true)] });
    expect(await createBranchPullRequests(repo).openFor(BRANCH)).toEqual({ kind: 'fork', number: 21 });
  });

  it('reads one same-repository PR beside a same-named fork PR as the same-repository PR', async () => {
    withGh({ pullRequests: [pr(21, SHA_C, true), pr(12, SHA_A)] });
    expect(await createBranchPullRequests(repo).openFor(BRANCH)).toEqual({ kind: 'open', number: 12, headSha: SHA_A });
  });

  it('reads an absent gh as github-unavailable, saying gh is missing', async () => {
    process.env.PATH = tools;
    const found = await createBranchPullRequests(repo).openFor(BRANCH);
    expect.soft(found.kind).toBe('github-unavailable');
    const reason = found.kind === 'github-unavailable' ? found.reason : '';
    expect.soft(reason).toMatch(MISSING);
    expect.soft(reason).not.toMatch(LOGGED_OUT);
  });

  it('reads a logged-out gh as github-unavailable, saying it is not logged in', async () => {
    withGh({ loggedIn: false, pullRequests: [pr(12, SHA_A)] });
    const found = await createBranchPullRequests(repo).openFor(BRANCH);
    expect.soft(found.kind).toBe('github-unavailable');
    const reason = found.kind === 'github-unavailable' ? found.reason : '';
    expect.soft(reason).toMatch(LOGGED_OUT);
    expect.soft(reason).not.toMatch(MISSING);
  });
});

describe('the proof PR-lookup adapter when the open PRs cannot be read', () => {
  it('reads a repository with no GitHub origin as github-unavailable, naming the branch', async () => {
    withGh({ pullRequests: [pr(12, SHA_A)] });
    git.git(repo, ['remote', 'remove', 'origin']);
    const found = await createBranchPullRequests(repo).openFor(BRANCH);
    expect.soft(found.kind).toBe('github-unavailable');
    expect.soft(found.kind === 'github-unavailable' ? found.reason : '').toContain(BRANCH);
  });

  it('reads a PR whose head is not a commit ID as github-unavailable, not as open', async () => {
    withGh({ pullRequests: [pr(12, 'not-a-commit')] });
    const found = await createBranchPullRequests(repo).openFor(BRANCH);
    expect.soft(found.kind).toBe('github-unavailable');
    expect.soft(found.kind === 'github-unavailable' ? found.reason : '').toContain(BRANCH);
  });
});

describe('the proof PR-lookup adapter with more than one gh account', () => {
  it('reads the open PR when the active login works but another account has a stale token', async () => {
    withGh({ otherAccountBroken: true, pullRequests: [pr(12, SHA_A)] });
    expect(await createBranchPullRequests(repo).openFor(BRANCH)).toEqual({ kind: 'open', number: 12, headSha: SHA_A });
  });
});

describe('the proof PR-lookup adapter refuses a PR list entry it cannot trust', () => {
  it('reads a PR whose URL is in another repository as github-unavailable, not as open', async () => {
    withGh({ pullRequests: [{ ...pr(12, SHA_A), url: 'https://github.com/other/repo/pull/12' }] });
    const found = await createBranchPullRequests(repo).openFor(BRANCH);
    expect.soft(found.kind).toBe('github-unavailable');
    expect.soft(found.kind === 'github-unavailable' ? found.reason : '').toContain(BRANCH);
  });

  it('reads a PR that does not say whether it is cross-repository as github-unavailable, not as open', async () => {
    const { isCrossRepository: _omitted, ...unmarked } = pr(12, SHA_A);
    withGh({ pullRequests: [unmarked] });
    const found = await createBranchPullRequests(repo).openFor(BRANCH);
    expect.soft(found.kind).toBe('github-unavailable');
    expect.soft(found.kind === 'github-unavailable' ? found.reason : '').toContain(BRANCH);
  });
});

describe('the proof PR-lookup adapter when gh cannot check the login', () => {
  it('carries what gh said into the reason when the login check fails for another cause', async () => {
    const said = 'error connecting to api.github.com: dial tcp: i/o timeout';
    withGh({ authStatusError: said, pullRequests: [pr(12, SHA_A)] });
    const found = await createBranchPullRequests(repo).openFor(BRANCH);
    expect.soft(found.kind).toBe('github-unavailable');
    expect.soft(found.kind === 'github-unavailable' ? found.reason : '').toContain(said);
  });

  it('does not report a login check that was killed as a logged-out gh', async () => {
    withGh({ authStatusKilled: true, pullRequests: [pr(12, SHA_A)] });
    const found = await createBranchPullRequests(repo).openFor(BRANCH);
    expect.soft(found.kind).toBe('github-unavailable');
    const reason = found.kind === 'github-unavailable' ? found.reason : '';
    expect.soft(reason).not.toBe('');
    expect.soft(reason).not.toMatch(/not logged in|auth login/i);
  });
});
