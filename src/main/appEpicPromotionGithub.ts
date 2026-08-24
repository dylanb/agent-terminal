// §28.7 — the real GitHub adapter for epic promotion. Sibling to appBootstrapGithub.ts: every value crosses the
// boundary as an argv element or on stdin (never shell-interpolated — CWE-78), and `--repo <selector>` pins the
// repository on every call. Untrusted sub-ticket titles/bodies flow through here as `--title` argv / `--body-file -`
// stdin, so a crafted title can never inject a command.

import { errMsg } from './errno';
import { numberFromGithubUrl } from '../shared/githubUrl';
import { runAppCommand } from './appCommand';
import { createGitHubRepositorySource, type GitHubRepositorySource } from './githubRepository';
import type { AppEpicPromotionGitHub } from './epicPromotion';

export function createRealAppEpicPromotionGitHub(
  repoDir: string,
  repositorySource: GitHubRepositorySource = createGitHubRepositorySource(repoDir),
): AppEpicPromotionGitHub {
  const gh = async (args: string[], failure: string, stdin?: string): Promise<string> => {
    const identity = await repositorySource.resolve();
    try {
      return await runAppCommand('gh', [...args, '--repo', identity.selector], repoDir, stdin);
    } catch (e) {
      throw new Error(`${failure}: ${errMsg(e)}`);
    }
  };
  return {
    createIssue: async (title, body) => {
      const out = await gh(['issue', 'create', '--title', title, '--body-file', '-'], 'sub-ticket creation failed', body);
      const number = numberFromGithubUrl(out);
      if (number === null) throw new Error('sub-ticket creation outcome was not recognized');
      return number;
    },
    addLabel: async (issue, label) =>
      void (await gh(['issue', 'edit', String(issue), '--add-label', label], 'sub-ticket label update failed')),
    appendIssueBody: async (issue, textToAppend, marker) => {
      const current = await gh(['issue', 'view', String(issue), '--json', 'body', '-q', '.body'], 'epic body read failed');
      // §27.10 — an empty read must never clobber the human's intent contract with a bare checklist.
      if (current.trim().length === 0) throw new Error('refused to append to an empty epic issue body');
      if (current.includes(marker)) return; // already appended (idempotent resume) — never double-append
      await gh(['issue', 'edit', String(issue), '--body-file', '-'], 'epic tracking update failed', `${current.replace(/\n+$/, '')}${textToAppend}`);
    },
    closePr: async (pr) => void (await gh(['pr', 'close', String(pr)], 'epic planning PR close failed')),
  };
}
