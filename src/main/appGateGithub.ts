import { readFile } from 'node:fs/promises';
import { createGitHubPullRequestBodies } from './pullRequestBody';
import { errMsg } from './errno';
import { GH_ACTION, TICKET_RUN_EFFECTS } from './gateEffects';
import type { AppLoopBootstrap } from './appLoopState';
import type { RunPickup } from './trustedPickups';
import { isAdoptedPickup } from '../shared/appBootstrap';
import { runAppCommand } from './appCommand';
import { createGitHubRepositorySource, type GitHubRepositoryIdentity } from './githubRepository';
import { createRealPullRequestLookup, pickupMismatch, type PullRequest } from './pullRequestLookup';

export interface AppGateSideEffectCtx {
  pr: number | null;
  ticket: number | null;
  bodyFile: string | null;
  pickup: RunPickup | null;
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

export function createAppGateGitHub(
  github: AppGateGitHubOperations,
): RunAppGateSideEffect {
  const verifyBootstrap = async (ctx: AppGateSideEffectCtx, bootstrap: AppLoopBootstrap | null): Promise<void> => {
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
  };

  return async (action, ctx) => {
    if (ctx.pickup !== null && isAdoptedPickup(ctx.pickup) && TICKET_RUN_EFFECTS.has(action)) {
      throw new Error(
        `${action} acts on a ticket run's own PR and ticket, and this run adopted PR #${ctx.pickup.pr}; it wrote nothing — remove ${action} from this gate, or terminate the run`,
      );
    }
    const bootstrap = ctx.pickup === null || isAdoptedPickup(ctx.pickup) ? null : ctx.pickup;
    switch (action) {
      case GH_ACTION.markReady:
        if (ctx.pr === null) return { outcome: 'no-target', reason: 'no PR to mark ready' };
        await verifyBootstrap(ctx, bootstrap);
        await github.markPullRequestReady(ctx.pr);
        return { outcome: 'done' };
      case GH_ACTION.updateIssueBody:
        if (ctx.ticket === null) {
          return { outcome: 'no-target', reason: 'no issue to publish the body to' };
        }
        if (ctx.bodyFile === null) {
          throw new Error('no body artifact to publish');
        }
        await github.updateIssueBody(ctx.ticket, ctx.bodyFile);
        return { outcome: 'done' };
      case GH_ACTION.publishPrBody:
        if (ctx.pr === null) {
          return { outcome: 'no-target', reason: 'no PR to publish the body to' };
        }
        if (ctx.bodyFile === null) {
          throw new Error('no body artifact to publish');
        }
        await verifyBootstrap(ctx, bootstrap);
        await github.publishPullRequestBody(
          ctx.pr,
          ctx.bodyFile,
          bootstrap?.issue ?? null,
        );
        return { outcome: 'done' };
      default:
        throw new Error(`unknown approve side-effect action: ${action}`);
    }
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
