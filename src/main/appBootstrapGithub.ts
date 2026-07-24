import { runAppCommand } from './appCommand';
import { numberFromGithubUrl } from '../shared/githubUrl';
import { isRecord } from './yamlRecord';
import {
  matchesGitHubRepositoryUrl,
  type GitHubRepositorySource,
} from './githubRepository';
import type { AppBootstrapGitHub } from './appLoopBootstrap';

export function createRealAppBootstrapGitHub(
  repoDir: string,
  repositorySource: GitHubRepositorySource,
): AppBootstrapGitHub {
  const gh = (args: string[]): Promise<string> =>
    runAppCommand('gh', args, repoDir);
  return {
    viewIssue: async (issue) => {
      try {
        const identity = await repositorySource.resolve();
        const parsed: unknown = JSON.parse(
          await gh([
            'issue',
            'view',
            String(issue),
            '--repo',
            identity.selector,
            '--json',
            'title,url',
          ]),
        );
        if (
          isRecord(parsed) &&
          typeof parsed.title === 'string' &&
          typeof parsed.url === 'string' &&
          matchesGitHubRepositoryUrl(
            parsed.url,
            identity,
            'issues',
            issue,
          )
        ) {
          return { title: parsed.title, url: parsed.url };
        }
        return null;
      } catch {
        return null;
      }
    },
    assignIssueToSelf: async (issue) => {
      const identity = await repositorySource.resolve();
      await gh([
        'issue',
        'edit',
        String(issue),
        '--add-assignee',
        '@me',
        '--repo',
        identity.selector,
      ]);
    },
    setIssueLabel: async (issue, label, on) => {
      const identity = await repositorySource.resolve();
      await gh([
        'issue',
        'edit',
        String(issue),
        on ? '--add-label' : '--remove-label',
        label,
        '--repo',
        identity.selector,
      ]);
    },
    createDraftPr: async ({ base, head, title, body }) => {
      const identity = await repositorySource.resolve();
      const out = await gh([
        'pr',
        'create',
        '--draft',
        '--base',
        base,
        '--head',
        head,
        '--title',
        title,
        '--body',
        body,
        '--repo',
        identity.selector,
      ]);
      const number = numberFromGithubUrl(out);
      return number !== null &&
        matchesGitHubRepositoryUrl(out.trim(), identity, 'pull', number)
        ? number
        : null;
    },
    setPrLabel: async (pullRequest, label, on) => {
      const identity = await repositorySource.resolve();
      await gh([
        'pr',
        'edit',
        String(pullRequest),
        on ? '--add-label' : '--remove-label',
        label,
        '--repo',
        identity.selector,
      ]);
    },
  };
}
