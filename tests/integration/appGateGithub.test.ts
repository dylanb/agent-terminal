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
  it('marks an unbound PR ready without fabricating bootstrap identity', async () => {
    const g = githubState();
    await createAppGateGitHub(g.github)('mark-ready', {
      pr: 42,
      ticket: null,
      bodyFile: null,
      bootstrap: null,
    });
    expect(g.state.ready).toEqual(new Set([42]));
  });

  it('publishes the groom artifact without consulting stale PR state', async () => {
    const g = githubState({
      number: 42,
      branch: 'tampered',
      state: 'CLOSED',
      closingIssues: [],
    });
    const bodyFile =
      '/repo/.agent-terminal/loop/artifacts/groomed-ticket.md';
    await createAppGateGitHub(g.github)('update-issue-body', {
      pr: 42,
      ticket: 78,
      bodyFile,
      bootstrap: {
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
      bootstrap: null,
    });
    expect(g.state.pullRequestBodies).toEqual(
      new Map([[99, { bodyFile, closingIssue: null }]]),
    );
  });

  it('fails without mutating GitHub when a required input is absent', async () => {
    const g = githubState();
    const run = createAppGateGitHub(g.github);
    await expect(
      run('mark-ready', {
        pr: null,
        ticket: null,
        bodyFile: null,
        bootstrap: null,
      }),
    ).rejects.toThrow(/no PR/);
    await expect(
      run('publish-pr-body', {
        pr: 5,
        ticket: null,
        bodyFile: null,
        bootstrap: null,
      }),
    ).rejects.toThrow(/body artifact/);
    await expect(
      run('update-issue-body', {
        pr: null,
        ticket: null,
        bodyFile: '/x',
        bootstrap: null,
      }),
    ).rejects.toThrow(/no issue/);
    expect(g.state.ready).toEqual(new Set());
    expect(g.state.issueBodies).toEqual(new Map());
    expect(g.state.pullRequestBodies).toEqual(new Map());
  });

  it('rejects an unknown action without exposing a generic command seam', async () => {
    const g = githubState();
    await expect(
      createAppGateGitHub(g.github)('rm-rf', {
        pr: 1,
        ticket: 1,
        bodyFile: '/x',
        bootstrap: null,
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
      bootstrap: {
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
      bootstrap: {
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

  it('refuses a tampered persisted bootstrap identity before mutation', async () => {
    const g = githubState({
      number: 42,
      branch: 'other/branch',
      state: 'OPEN',
      closingIssues: [999],
    });
    await expect(
      createAppGateGitHub(g.github)('mark-ready', {
        pr: 42,
        ticket: 78,
        bodyFile: null,
        bootstrap: {
          pr: 42,
          issue: 78,
          branch: 'plan-loop/issue-78',
          initialStatus: 'planning',
        },
      }),
    ).rejects.toThrow(/bootstrap PR identity/i);
    expect(g.state.ready).toEqual(new Set());
  });
});
