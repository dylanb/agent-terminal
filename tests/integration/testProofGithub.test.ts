import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import {
  hermeticPath,
  installTestProofGh,
  TEST_PROOF_GH_ORIGIN,
  type StandInComment,
  type StandInPullRequest,
  type TestProofGh,
} from '../helpers/testProofGh';
import { createBranchPullRequests, createProofPublisher, TEST_PROOF_COMMENT_MARKER } from '../../src/main/testProofPorts';
import type { ProofPublisher } from '../../src/main/testProof';

const BRANCH = 'feature/proof';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const originalPath = process.env.PATH;
const GITHUB_MAX_PER_PAGE = 100;
const GITHUB_MAX_COMMENT_CHARS = 65_536;
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

function withGh(initial: Parameters<typeof installTestProofGh>[1]): TestProofGh {
  const bin = join(scratch, 'gh-bin');
  const gh = installTestProofGh(bin, initial);
  process.env.PATH = `${bin}:${tools}`;
  return gh;
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

describe('the proof publisher (stand-in gh)', () => {
  it('takes only the two proof check names as a status name', () => {
    expectTypeOf<ProofPublisher['status']>().parameter(1).toEqualTypeOf<'test-proof/vitest' | 'test-proof/e2e'>();
  });

  it.each(['test-proof/vitest', 'test-proof/e2e'] as const)('posts a success status for %s on the given SHA with the given description', async (context) => {
    const gh = withGh({});
    const description = `5412 passed, 26 skipped, 13 flaky (${context})`;
    await createProofPublisher(repo).status(SHA_B, context, description);
    expect(gh.read().statuses).toEqual([{ sha: SHA_B, state: 'success', context, description }]);
  });

  it('edits the summary it posted before, found past the largest page GitHub serves, and leaves a marked comment by another login alone', async () => {
    const others: StandInComment[] = Array.from({ length: GITHUB_MAX_PER_PAGE + 5 }, (_, i) => ({ id: 100 + i, login: 'reviewer', body: `review note ${i}` }));
    const foreign: StandInComment = { id: 99, login: 'another-prover', body: `${TEST_PROOF_COMMENT_MARKER}\nsomeone else's proof` };
    const note: StandInComment = { id: 98, login: 'proof-author', body: 'a hand-written note by the same login' };
    const gh = withGh({ comments: { '12': [foreign, note, ...others] } });
    await createProofPublisher(repo).summary(12, 'first proof of aaaa');
    await createProofPublisher(repo).summary(12, 'second proof of bbbb');
    const comments = gh.read().comments['12'] ?? [];
    const summaries = comments.filter((c) => c.login === 'proof-author' && c.id !== note.id);
    expect.soft(summaries).toHaveLength(1);
    expect.soft(summaries[0]?.body ?? '').toContain('second proof of bbbb');
    expect.soft(summaries[0]?.body ?? '').not.toContain('first proof of aaaa');
    expect.soft(comments.find((c) => c.id === note.id)).toEqual(note);
    expect.soft(comments.find((c) => c.id === foreign.id)).toEqual(foreign);
    expect.soft(comments.filter((c) => c.login === 'reviewer')).toEqual(others);
  });

  it('edits the summary it posted before when the comments ahead of it are as long as GitHub allows, in 4-byte characters', async () => {
    const long: StandInComment[] = Array.from({ length: 20 }, (_, i) => ({ id: 200 + i, login: 'reviewer', body: '\u{1F600}'.repeat(GITHUB_MAX_COMMENT_CHARS) }));
    const gh = withGh({ comments: { '12': long } });
    await createProofPublisher(repo).summary(12, 'first proof of aaaa');
    await createProofPublisher(repo).summary(12, 'second proof of bbbb');
    const summaries = (gh.read().comments['12'] ?? []).filter((c) => c.login === 'proof-author');
    expect(summaries.map((c) => c.body.includes('second proof of bbbb'))).toEqual([true]);
  });

  it('leaves a comment by the proving login that quotes the marker mid-body alone, and posts its own summary', async () => {
    const quoting: StandInComment = { id: 97, login: 'proof-author', body: `the summary starts with ${TEST_PROOF_COMMENT_MARKER}, see below` };
    const gh = withGh({ comments: { '12': [quoting] } });
    await createProofPublisher(repo).summary(12, 'first proof of aaaa');
    const comments = gh.read().comments['12'] ?? [];
    expect.soft(comments.find((c) => c.id === quoting.id)).toEqual(quoting);
    expect.soft(comments.filter((c) => c.body.includes('first proof of aaaa'))).toHaveLength(1);
  });

  it('rejects the status promise when GitHub refuses the status', async () => {
    withGh({ failStatusFor: ['test-proof/e2e'] });
    await expect(createProofPublisher(repo).status(SHA_A, 'test-proof/e2e', '391 passed')).rejects.toThrow();
  });

  it('rejects the summary promise when GitHub refuses to create the comment', async () => {
    withGh({ failCommentWrite: true });
    await expect(createProofPublisher(repo).summary(12, 'first proof')).rejects.toThrow();
  });

  it('rejects the summary promise when GitHub refuses to edit the earlier comment', async () => {
    const gh = withGh({});
    await createProofPublisher(repo).summary(12, 'first proof');
    gh.set({ failCommentWrite: true });
    await expect(createProofPublisher(repo).summary(12, 'second proof')).rejects.toThrow();
  });
});
