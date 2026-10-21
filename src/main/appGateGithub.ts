import { readFile } from 'node:fs/promises';
import { errMsg } from './errno';
import type { AppLoopBootstrap } from './appLoopState';
import { runAppCommand } from './appCommand';
import { createGitHubRepositorySource, type GitHubRepositoryIdentity } from './githubRepository';
import { createRealPullRequestLookup, pickupMismatch, type PullRequest } from './pullRequestLookup';

export interface AppGateSideEffectCtx {
  pr: number | null;
  ticket: number | null;
  bodyFile: string | null;
  bootstrap: AppLoopBootstrap | null;
}

export type RunAppGateSideEffect = (
  action: string,
  ctx: AppGateSideEffectCtx,
) => Promise<void>;

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
  const verifyBootstrap = async (ctx: AppGateSideEffectCtx): Promise<void> => {
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
    if (pickupMismatch(pullRequest, bootstrap) !== null) {
      throw new Error('bootstrap PR identity does not match GitHub');
    }
  };

  return async (action, ctx) => {
    switch (action) {
      case 'mark-ready':
        if (ctx.pr === null) throw new Error('no PR to mark ready');
        await verifyBootstrap(ctx);
        await github.markPullRequestReady(ctx.pr);
        return;
      case 'update-issue-body':
        if (ctx.ticket === null) {
          throw new Error('no issue to publish the body to');
        }
        if (ctx.bodyFile === null) {
          throw new Error('no body artifact to publish');
        }
        await github.updateIssueBody(ctx.ticket, ctx.bodyFile);
        return;
      case 'publish-pr-body':
        if (ctx.pr === null) {
          throw new Error('no PR to publish the body to');
        }
        if (ctx.bodyFile === null) {
          throw new Error('no body artifact to publish');
        }
        await verifyBootstrap(ctx);
        await github.publishPullRequestBody(
          ctx.pr,
          ctx.bodyFile,
          ctx.bootstrap?.issue ?? null,
        );
        return;
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
      const identity = await repository();
      let body: string;
      try {
        body = await readFile(bodyFile, 'utf8');
      } catch (e) {
        throw new Error(`could not read the PR body artifact: ${errMsg(e)}`);
      }
      if (body.trim().length === 0) {
        throw new Error('refused to publish an empty PR body artifact');
      }
      if (closingIssue === null) {
        await runAppCommand(
          'gh',
          [
            'pr',
            'edit',
            String(pullRequest),
            '--body-file',
            '-',
            '--repo',
            identity.selector,
          ],
          repoDir,
          body,
        );
        return;
      }
      const artifact = body.trimEnd();
      const closingLine = `closes #${closingIssue}`;
      await runAppCommand(
        'gh',
        [
          'pr',
          'edit',
          String(pullRequest),
          '--body-file',
          '-',
          '--repo',
          identity.selector,
        ],
        repoDir,
        `${artifact}\n\n${closingLine}\n`,
      );
    },
  };
  return createAppGateGitHub(github);
}
