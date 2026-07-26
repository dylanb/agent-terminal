import { readFile } from 'node:fs/promises';
import { errMsg } from './errno';
import type { AppLoopBootstrap } from './appLoopState';
import { runAppCommand } from './appCommand';
import {
  createGitHubRepositorySource,
  matchesGitHubRepositoryUrl,
  type GitHubRepositoryIdentity,
} from './githubRepository';
import { isRecord } from './yamlRecord';

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

export interface AppGatePullRequest {
  number: number;
  branch: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  closingIssues: number[];
}

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
    if (
      pullRequest.number !== bootstrap.pr ||
      pullRequest.branch !== bootstrap.branch ||
      pullRequest.state !== 'OPEN' ||
      !pullRequest.closingIssues.includes(bootstrap.issue)
    ) {
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

function parsePullRequest(
  value: unknown,
  expectedNumber: number,
  repository: GitHubRepositoryIdentity,
): AppGatePullRequest {
  if (
    !isRecord(value) ||
    value.number !== expectedNumber ||
    typeof value.url !== 'string' ||
    !matchesGitHubRepositoryUrl(
      value.url,
      repository,
      'pull',
      expectedNumber,
    ) ||
    typeof value.headRefName !== 'string' ||
    (value.state !== 'OPEN' &&
      value.state !== 'CLOSED' &&
      value.state !== 'MERGED') ||
    !Array.isArray(value.closingIssuesReferences)
  ) {
    throw new Error('invalid GitHub pull request identity');
  }
  const closingIssues = value.closingIssuesReferences.map((entry) => {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.number) ||
      (entry.number as number) <= 0 ||
      typeof entry.url !== 'string' ||
      !matchesGitHubRepositoryUrl(
        entry.url,
        repository,
        'issues',
        entry.number as number,
      )
    ) {
      throw new Error('invalid GitHub closing issue identity');
    }
    return entry.number as number;
  });
  return {
    number: expectedNumber,
    branch: value.headRefName,
    state: value.state,
    closingIssues,
  };
}

export function createRealAppGateGitHub(
  repoDir: string,
): RunAppGateSideEffect {
  const repositorySource = createGitHubRepositorySource(repoDir);
  const repository = (): Promise<GitHubRepositoryIdentity> =>
    repositorySource.resolve();
  const github: AppGateGitHubOperations = {
    pullRequest: async (number) => {
      const identity = await repository();
      const viewed = await runAppCommand(
        'gh',
        [
          'pr',
          'view',
          String(number),
          '--repo',
          identity.selector,
          '--json',
          'number,url,headRefName,state,closingIssuesReferences',
        ],
        repoDir,
      );
      let raw: unknown;
      try {
        raw = JSON.parse(viewed);
      } catch {
        throw new Error('invalid GitHub pull request identity');
      }
      return parsePullRequest(raw, number, identity);
    },
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
