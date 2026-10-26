import { runAppCommand } from './appCommand';
import { createGitHubRepositorySource } from './githubRepository';

export interface PullRequestBodies {
  readBody(pr: number): Promise<string>;
  replaceBody(pr: number, body: string): Promise<void>;
}

export function createGitHubPullRequestBodies(repoDir: string): PullRequestBodies {
  const repository = createGitHubRepositorySource(repoDir);
  return {
    readBody: async (pr) => {
      const identity = await repository.resolve();
      const value: unknown = JSON.parse(await runAppCommand('gh', ['pr', 'view', String(pr), '--repo', identity.selector, '--json', 'body'], repoDir));
      if (!value || typeof value !== 'object' || !('body' in value) || typeof value.body !== 'string') {
        throw new Error('GitHub returned no PR body');
      }
      return value.body;
    },
    replaceBody: async (pr, body) => {
      const identity = await repository.resolve();
      await runAppCommand('gh', ['pr', 'edit', String(pr), '--body-file', '-', '--repo', identity.selector], repoDir, body);
    },
  };
}
