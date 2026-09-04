// §27.10 N10 — the real GitHub read that classifies a picked-up issue as an epic sub-ticket: `gh issue view
// <n> --json body,labels`, pinned to the repo like the other adapters (appEpicPromotionGithub.ts). The JSON is
// untrusted; `parseIssueBodyLabels` normalizes it to one flat shape the pickup classifier reads.

import { isRecord } from './yamlRecord';
import { runAppCommand } from './appCommand';
import { createGitHubRepositorySource, type GitHubRepositorySource } from './githubRepository';

/** Parse `gh issue view --json body,labels` output into `{ body, labels }`, or null when it is not a JSON object.
 *  gh returns `labels: [{name, …}]`; entries without a string name are dropped, and a missing body reads ''. */
export function parseIssueBodyLabels(out: string): { body: string; labels: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const body = typeof parsed.body === 'string' ? parsed.body : '';
  const labels = Array.isArray(parsed.labels)
    ? parsed.labels.reduce<string[]>((acc, l) => {
        if (isRecord(l) && typeof l.name === 'string') acc.push(l.name);
        return acc;
      }, [])
    : [];
  return { body, labels };
}

/** The picked-up issue's body + labels, or null when it cannot be read (a gh failure or an unrecognized payload
 *  reads as "not a sub-ticket", so a transient hiccup never blocks a normal pickup). */
export function createRealSubTicketIssueReader(
  repoDir: string,
  repositorySource: GitHubRepositorySource = createGitHubRepositorySource(repoDir),
): (issue: number) => Promise<{ body: string; labels: string[] } | null> {
  return async (issue) => {
    try {
      const identity = await repositorySource.resolve();
      const out = await runAppCommand('gh', ['issue', 'view', String(issue), '--json', 'body,labels', '--repo', identity.selector], repoDir);
      return parseIssueBodyLabels(out);
    } catch {
      return null;
    }
  };
}
