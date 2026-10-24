import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** §27.13 — `no-target` when the run has no PR or issue for the action to act on. */
export type AppGateSideEffectResult = { outcome: 'done' } | { outcome: 'no-target'; reason: string };

export type RunAppGateSideEffect = (
  action: string,
  ctx: AppGateSideEffectCtx,
) => Promise<AppGateSideEffectResult>;

export type AppGatePullRequest = PullRequest;

export interface AppGateGitHubOperations {
  pullRequest(number: number): Promise<AppGatePullRequest>;
  pullRequestBody?(number: number): Promise<string>;
  markPullRequestReady(number: number): Promise<void>;
  updateIssueBody(issue: number, bodyFile: string): Promise<void>;
  publishPullRequestBody(
    pullRequest: number,
    bodyFile: string,
    closingIssue: number | null,
  ): Promise<void>;
}

function composeFlowAudit(body: string, report: string): string {
  const start = '<!-- agent-terminal:flow-audit:start -->';
  const end = '<!-- agent-terminal:flow-audit:end -->';
  if (report.includes(start) || report.includes(end)) {
    throw new Error('audit artifact contains reserved section delimiters');
  }
  const starts = body.split(start);
  const ends = body.split(end);
  const section = `${start}\n${report}${end}\n`;
  if (starts.length === 1 && ends.length === 1) return `${body}\n${section}`;
  const first = body.indexOf(start);
  const last = body.indexOf(end);
  if (starts.length !== 2 || ends.length !== 2 || last < first) {
    throw new Error('PR audit section ownership is ambiguous or malformed');
  }
  const before = body.slice(0, first);
  const after = body.slice(last + end.length);
  if (after === '' || after === '\n') return `${before}${section}`;
  return `${before}${after}\n${section}`;
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
    const mismatch = pickupMismatch(pullRequest, bootstrap);
    if (mismatch !== null) throw new Error(`bootstrap PR identity does not match GitHub: ${mismatch}`);
  };

  return async (action, ctx) => {
    switch (action) {
      case 'mark-ready':
        if (ctx.pr === null) return { outcome: 'no-target', reason: 'no PR to mark ready' };
        await verifyBootstrap(ctx);
        await github.markPullRequestReady(ctx.pr);
        return { outcome: 'done' };
      case 'update-issue-body':
        if (ctx.ticket === null) {
          return { outcome: 'no-target', reason: 'no issue to publish the body to' };
        }
        if (ctx.bodyFile === null) {
          throw new Error('no body artifact to publish');
        }
        await github.updateIssueBody(ctx.ticket, ctx.bodyFile);
        return { outcome: 'done' };
      case 'publish-flow-audit': {
        if (ctx.pr === null) return { outcome: 'no-target', reason: 'no PR to publish the audit to' };
        if (ctx.bodyFile === null) throw new Error('no audit artifact to publish');
        if (!github.pullRequestBody) throw new Error('PR body access is unavailable');
        await verifyBootstrap(ctx);
        const report = await readFile(ctx.bodyFile, 'utf8');
        if (!report.trim()) throw new Error('refused to publish an empty audit artifact');
        const body = await github.pullRequestBody(ctx.pr);
        const composed = composeFlowAudit(body, report);
        const dir = await mkdtemp(join(tmpdir(), 'flow-audit-'));
        try {
          const file = join(dir, 'body.md');
          await writeFile(file, composed, { mode: 0o600 });
          await github.publishPullRequestBody(ctx.pr, file, null);
          if (await github.pullRequestBody(ctx.pr) !== composed) {
            throw new Error('published PR body does not match the audit and retained description');
          }
        } finally {
          try {
            await rm(dir, { recursive: true, force: true });
          } catch (error: unknown) {
            console.warn(`Could not clean audit publication temporary directory ${dir}: ${errMsg(error)}`);
          }
        }
        return { outcome: 'done' };
      }
      case 'publish-pr-body':
        if (ctx.pr === null) {
          return { outcome: 'no-target', reason: 'no PR to publish the body to' };
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
  const repository = (): Promise<GitHubRepositoryIdentity> =>
    repositorySource.resolve();
  const github: AppGateGitHubOperations = {
    pullRequest: (number) => pullRequests.pullRequest(number),
    pullRequestBody: async (number) => {
      const identity = await repository();
      const value: unknown = JSON.parse(await runAppCommand('gh', ['pr', 'view', String(number), '--repo', identity.selector, '--json', 'body'], repoDir));
      if (!value || typeof value !== 'object' || !('body' in value) || typeof value.body !== 'string') {
        throw new Error('GitHub returned no PR body');
      }
      return value.body;
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
