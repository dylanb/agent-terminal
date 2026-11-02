import { readFile } from 'node:fs/promises';
import { createGitHubPullRequestBodies } from './pullRequestBody';
import { errMsg } from './errno';
import type { AppLoopBootstrap } from './appLoopState';
import { runAppCommand } from './appCommand';
import { createGitHubRepositorySource, type GitHubRepositoryIdentity } from './githubRepository';
import { createRealPullRequestLookup, pickupMismatch, type PullRequest } from './pullRequestLookup';
import { ACTED_GH_ACTIONS, isOneOf, type ActedGhAction } from '../shared/engineCapabilities/loop';

export interface AppGateSideEffectCtx {
  pr: number | null;
  ticket: number | null;
  bodyFile: string | null;
  bootstrap: AppLoopBootstrap | null;
}

/** §27.13 — `no-target` when the run has no PR or issue for the action to act on. */
export type AppGateSideEffectResult = { outcome: 'done' } | { outcome: 'no-target'; reason: string };

export type RunAppGateSideEffect = (
  action: string,
  ctx: AppGateSideEffectCtx,
) => Promise<AppGateSideEffectResult>;

export type AppGatePullRequest = PullRequest;

export interface AppGateGitHubOperations {
  pullRequest(number: number): Promise<AppGatePullRequest>;
  markPullRequestReady(number: number): Promise<void>;
  updateIssueBody(issue: number, bodyFile: string): Promise<void>;
  publishPullRequestBody(
    pullRequest: number,
    bodyFile: string,
    closingIssue: number | null,
  ): Promise<void>;
}

async function verifyBootstrap(github: AppGateGitHubOperations, ctx: AppGateSideEffectCtx): Promise<void> {
  const bootstrap = ctx.bootstrap;
  if (bootstrap === null) return;
  if (ctx.pr !== bootstrap.pr || ctx.ticket !== bootstrap.issue) {
    throw new Error('bootstrap PR identity does not match the gate refs');
  }
  let pullRequest: AppGatePullRequest;
  try {
    pullRequest = await github.pullRequest(bootstrap.pr);
  } catch (e) {
    throw new Error(
      `bootstrap PR identity could not be verified: ${errMsg(e)}`,
    );
  }
  const mismatch = pickupMismatch(pullRequest, bootstrap);
  if (mismatch !== null) throw new Error(`bootstrap PR identity does not match GitHub: ${mismatch}`);
}

type GhActionHandler = (github: AppGateGitHubOperations, ctx: AppGateSideEffectCtx) => Promise<AppGateSideEffectResult>;

export const GH_ACTION_HANDLERS: Readonly<Record<ActedGhAction, GhActionHandler>> = {
  'mark-ready': async (github, ctx) => {
    if (ctx.pr === null) return { outcome: 'no-target', reason: 'no PR to mark ready' };
    await verifyBootstrap(github, ctx);
    await github.markPullRequestReady(ctx.pr);
    return { outcome: 'done' };
  },
  'update-issue-body': async (github, ctx) => {
    if (ctx.ticket === null) {
      return { outcome: 'no-target', reason: 'no issue to publish the body to' };
    }
    if (ctx.bodyFile === null) {
      throw new Error('no body artifact to publish');
    }
    await github.updateIssueBody(ctx.ticket, ctx.bodyFile);
    return { outcome: 'done' };
  },
  'publish-pr-body': async (github, ctx) => {
    if (ctx.pr === null) {
      return { outcome: 'no-target', reason: 'no PR to publish the body to' };
    }
    if (ctx.bodyFile === null) {
      throw new Error('no body artifact to publish');
    }
    await verifyBootstrap(github, ctx);
    await github.publishPullRequestBody(
      ctx.pr,
      ctx.bodyFile,
      ctx.bootstrap?.issue ?? null,
    );
    return { outcome: 'done' };
  },
};

export function createAppGateGitHub(
  github: AppGateGitHubOperations,
): RunAppGateSideEffect {
  return async (action, ctx) => {
    if (!isOneOf(ACTED_GH_ACTIONS, action)) throw new Error(`unknown approve side-effect action: ${action}`);
    return GH_ACTION_HANDLERS[action](github, ctx);
  };
}

export function createRealAppGateGitHub(
  repoDir: string,
): RunAppGateSideEffect {
  const repositorySource = createGitHubRepositorySource(repoDir);
  const pullRequests = createRealPullRequestLookup(repoDir);
  const bodies = createGitHubPullRequestBodies(repoDir);
  const repository = (): Promise<GitHubRepositoryIdentity> =>
    repositorySource.resolve();
  const github: AppGateGitHubOperations = {
    pullRequest: (number) => pullRequests.pullRequest(number),
    markPullRequestReady: async (number) => {
      const identity = await repository();
      await runAppCommand(
        'gh',
        [
          'pr',
          'ready',
          String(number),
          '--repo',
          identity.selector,
        ],
        repoDir,
      );
    },
    updateIssueBody: async (issue, bodyFile) => {
      const identity = await repository();
      let body: string;
      try {
        body = await readFile(bodyFile, 'utf8');
      } catch (e) {
        throw new Error(`could not read the issue body artifact: ${errMsg(e)}`);
      }
      if (body.trim().length === 0) {
        throw new Error('refused to publish an empty issue body artifact');
      }
      await runAppCommand(
        'gh',
        [
          'issue',
          'edit',
          String(issue),
          '--body-file',
          '-',
          '--repo',
          identity.selector,
        ],
        repoDir,
        body,
      );
    },
    publishPullRequestBody: async (
      pullRequest,
      bodyFile,
      closingIssue,
    ) => {
      let body: string;
      try {
        body = await readFile(bodyFile, 'utf8');
      } catch (e) {
        throw new Error(`could not read the PR body artifact: ${errMsg(e)}`);
      }
      if (body.trim().length === 0) {
        throw new Error('refused to publish an empty PR body artifact');
      }
      await bodies.replaceBody(pullRequest, closingIssue === null
        ? body
        : `${body.trimEnd()}\n\ncloses #${closingIssue}\n`);
    },
  };
  return createAppGateGitHub(github);
}
