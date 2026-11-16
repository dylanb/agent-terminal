import { describe, expect, it } from 'vitest';
import { parseGitHubPullRequest } from '../../src/main/githubPullRequest';
import type { GitHubRepositoryIdentity } from '../../src/main/githubRepository';

const ORIGIN: GitHubRepositoryIdentity = { selector: 'github.com/owner/repo', owner: 'owner', name: 'repo', defaultBranch: 'main' };

const answer = (edit: Record<string, unknown> = {}): string =>
  JSON.stringify({
    number: 41,
    url: 'https://github.com/owner/repo/pull/41',
    state: 'OPEN',
    headRefName: 'feature',
    baseRefName: 'release',
    headRepository: { name: 'Fork' },
    headRepositoryOwner: { login: 'Contributor' },
    isCrossRepository: true,
    closingIssuesReferences: [{ number: 176, url: 'https://github.com/owner/repo/issues/176' }],
    ...edit,
  });

describe('parseGitHubPullRequest', () => {
  it('reads the pull request the app asked for: its state, branches, head repository and closing tickets', () => {
    expect(parseGitHubPullRequest(answer(), 41, ORIGIN)).toEqual({
      number: 41,
      state: 'OPEN',
      headRef: 'feature',
      baseRef: 'release',
      headRepo: 'contributor/fork',
      crossRepository: true,
      closingIssues: [{ number: 176, url: 'https://github.com/owner/repo/issues/176' }],
    });
  });

  it.each(['OPEN', 'CLOSED', 'MERGED'] as const)('reads GitHub state %s', (state) => {
    expect(parseGitHubPullRequest(answer({ state }), 41, ORIGIN).state).toBe(state);
  });

  it('reads no head repository when GitHub reports none, as for a deleted fork', () => {
    expect(parseGitHubPullRequest(answer({ headRepository: null, headRepositoryOwner: null }), 41, ORIGIN).headRepo).toBeNull();
  });

  it.each([
    ['a state GitHub does not define for a pull request, naming it', { state: 'DRAFT' }, /state DRAFT/],
    ['an answer for another pull request', { number: 42, url: 'https://github.com/owner/repo/pull/42' }, /#41/],
    ["an answer whose URL is another repository's", { url: 'https://github.com/other/repo/pull/41' }, /#41/],
    ['a closing ticket it cannot read', { closingIssuesReferences: [{ number: 'x' }] }, /closing ticket/],
    ['an answer without its base branch', { baseRefName: undefined }, /branches/],
  ])('refuses %s', (_case, edit, why) => {
    expect(() => parseGitHubPullRequest(answer(edit), 41, ORIGIN)).toThrow(why);
  });

  it('refuses an answer that is not JSON', () => {
    expect(() => parseGitHubPullRequest('not json', 41, ORIGIN)).toThrow(/not JSON/);
  });
});
