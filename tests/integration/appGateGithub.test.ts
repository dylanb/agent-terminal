import { describe, expect, it } from 'vitest';
import {
  createAppGateGitHub,
  type AppGateGitHubOperations,
  type AppGatePullRequest,
} from '../../src/main/appGateGithub';

interface GitHubState {
  pullRequests: Map<number, AppGatePullRequest>;
  ready: Set<number>;
  issueBodies: Map<number, string>;
  pullRequestBodies: Map<
    number,
    { bodyFile: string; closingIssue: number | null }
  >;
}

function githubState(
  pullRequest: AppGatePullRequest = {
    number: 42,
    branch: 'plan-loop/issue-78',
    state: 'OPEN',
    closingIssues: [78],
    crossRepository: false,
  },
): { state: GitHubState; github: AppGateGitHubOperations } {
  const state: GitHubState = {
    pullRequests: new Map([[pullRequest.number, pullRequest]]),
    ready: new Set(),
    issueBodies: new Map(),
    pullRequestBodies: new Map(),
  };
  return {
    state,
    github: {
      pullRequest: async (number) => {
        const value = state.pullRequests.get(number);
        if (value === undefined) throw new Error('not found');
        return value;
      },
      markPullRequestReady: async (number) => {
        state.ready.add(number);
      },
      updateIssueBody: async (issue, bodyFile) => {
        state.issueBodies.set(issue, bodyFile);
      },
      publishPullRequestBody: async (
        number,
        bodyFile,
        closingIssue,
      ) => {
        state.pullRequestBodies.set(number, {
          bodyFile,
          closingIssue,
        });
      },
    },
  };
}

describe('§27 approve side-effect port (appGateGithub)', () => {
  it('keeps why the bootstrap PR identity could not be verified', async () => {
    const { github } = githubState();
    const run = createAppGateGitHub({
      ...github,
      pullRequest: async () => {
        throw new Error('gh command failed (exit 4)');
      },
    });

    await expect(
      run('mark-ready', {
        pr: 42,
        ticket: 78,
        bodyFile: null,
        pickup: {
          pr: 42,
          issue: 78,
          branch: 'plan-loop/issue-78',
          initialStatus: 'planning',
        },
      }),
    ).rejects.toThrow(/exit 4/);
  });

  it('coerces a non-Error verification failure into the reason', async () => {
    const { github } = githubState();
    const run = createAppGateGitHub({
      ...github,
      pullRequest: async () => {
        throw 'lookup exploded';
      },
    });

    await expect(
      run('mark-ready', {
        pr: 42,
        ticket: 78,
        bodyFile: null,
        pickup: {
          pr: 42,
          issue: 78,
          branch: 'plan-loop/issue-78',
          initialStatus: 'planning',
        },
      }),
    ).rejects.toThrow(/lookup exploded/);
  });

  it('marks an unbound PR ready without fabricating bootstrap identity', async () => {
    const g = githubState();
    await createAppGateGitHub(g.github)('mark-ready', {
      pr: 42,
      ticket: null,
      bodyFile: null,
      pickup: null,
    });
    expect(g.state.ready).toEqual(new Set([42]));
  });

  it('publishes the groom artifact without consulting stale PR state', async () => {
    const g = githubState({
      number: 42,
      branch: 'tampered',
      state: 'CLOSED',
      closingIssues: [],
      crossRepository: false,
    });
    const bodyFile =
      '/repo/.agent-terminal/loop/artifacts/groomed-ticket.md';
    await createAppGateGitHub(g.github)('update-issue-body', {
      pr: 42,
      ticket: 78,
      bodyFile,
      pickup: {
        pr: 42,
        issue: 78,
        branch: 'plan-loop/issue-78',
        initialStatus: 'planning',
      },
    });
    expect(g.state.issueBodies).toEqual(new Map([[78, bodyFile]]));
  });

  it('publishes an unbound PR body without adding a closing issue', async () => {
    const g = githubState();
    const bodyFile = '/repo/.agent-terminal/loop/artifacts/plan.md';
    await createAppGateGitHub(g.github)('publish-pr-body', {
      pr: 99,
      ticket: null,
      bodyFile,
      pickup: null,
    });
    expect(g.state.pullRequestBodies).toEqual(
      new Map([[99, { bodyFile, closingIssue: null }]]),
    );
  });

  it('has nothing to act on without a PR or issue, and mutates nothing (§27.13)', async () => {
    const g = githubState();
    const run = createAppGateGitHub(g.github);
    await expect(run('mark-ready', { pr: null, ticket: null, bodyFile: null, pickup: null })).resolves.toEqual({
      outcome: 'no-target',
      reason: expect.stringMatching(/no PR/),
    });
    await expect(run('publish-pr-body', { pr: null, ticket: null, bodyFile: '/x', pickup: null })).resolves.toEqual({
      outcome: 'no-target',
      reason: expect.stringMatching(/no PR/),
    });
    await expect(run('update-issue-body', { pr: null, ticket: null, bodyFile: '/x', pickup: null })).resolves.toEqual({
      outcome: 'no-target',
      reason: expect.stringMatching(/no issue/),
    });
    expect(g.state.ready).toEqual(new Set());
    expect(g.state.issueBodies).toEqual(new Map());
    expect(g.state.pullRequestBodies).toEqual(new Map());
  });

  it('reports a side-effect that acted as done', async () => {
    const g = githubState();
    await expect(createAppGateGitHub(g.github)('mark-ready', { pr: 7, ticket: null, bodyFile: null, pickup: null })).resolves.toEqual({ outcome: 'done' });
    expect(g.state.ready).toEqual(new Set([7]));
  });

  it('fails without mutating GitHub when the body artifact is absent', async () => {
    const g = githubState();
    await expect(
      createAppGateGitHub(g.github)('publish-pr-body', { pr: 5, ticket: null, bodyFile: null, pickup: null }),
    ).rejects.toThrow(/body artifact/);
    expect(g.state.pullRequestBodies).toEqual(new Map());
  });

  it('rejects an unknown action without exposing a generic command seam', async () => {
    const g = githubState();
    await expect(
      createAppGateGitHub(g.github)('rm-rf', {
        pr: 1,
        ticket: 1,
        bodyFile: '/x',
        pickup: null,
      }),
    ).rejects.toThrow(/unknown approve side-effect action/);
    expect(g.state.ready).toEqual(new Set());
    expect(g.state.issueBodies).toEqual(new Map());
    expect(g.state.pullRequestBodies).toEqual(new Map());
  });

  it('verifies the persisted bootstrap identity before marking its PR ready', async () => {
    const g = githubState();
    await createAppGateGitHub(g.github)('mark-ready', {
      pr: 42,
      ticket: 78,
      bodyFile: null,
      pickup: {
        pr: 42,
        issue: 78,
        branch: 'plan-loop/issue-78',
        initialStatus: 'planning',
      },
    });
    expect(g.state.ready).toEqual(new Set([42]));
  });

  it('preserves the bootstrap closing issue in the implementation body', async () => {
    const g = githubState();
    const bodyFile = '/repo/.agent-terminal/loop/artifacts/plan.md';
    await createAppGateGitHub(g.github)('publish-pr-body', {
      pr: 42,
      ticket: 78,
      bodyFile,
      pickup: {
        pr: 42,
        issue: 78,
        branch: 'plan-loop/issue-78',
        initialStatus: 'planning',
      },
    });
    expect(g.state.pullRequestBodies).toEqual(
      new Map([[42, { bodyFile, closingIssue: 78 }]]),
    );
  });

  it('refuses a bootstrap PR opened from a fork before mutation', async () => {
    const g = githubState({ number: 42, branch: 'plan-loop/issue-78', state: 'OPEN', closingIssues: [78], crossRepository: true });
    await expect(
      createAppGateGitHub(g.github)('mark-ready', {
        pr: 42,
        ticket: 78,
        bodyFile: null,
        pickup: { pr: 42, issue: 78, branch: 'plan-loop/issue-78', initialStatus: 'planning' },
      }),
    ).rejects.toThrow(/pull request #42 is from another repository/);
    expect(g.state.ready).toEqual(new Set());
  });

  it('refuses a tampered persisted bootstrap identity before mutation', async () => {
    const g = githubState({
      number: 42,
      branch: 'other/branch',
      state: 'OPEN',
      closingIssues: [999],
      crossRepository: false,
    });
    await expect(
      createAppGateGitHub(g.github)('mark-ready', {
        pr: 42,
        ticket: 78,
        bodyFile: null,
        pickup: {
          pr: 42,
          issue: 78,
          branch: 'plan-loop/issue-78',
          initialStatus: 'planning',
        },
      }),
    ).rejects.toThrow(/bootstrap PR identity does not match GitHub: pull request #42 is on other\/branch, not plan-loop\/issue-78/);
    expect(g.state.ready).toEqual(new Set());
  });
});
