import { numberFromGithubUrl } from '../shared/githubUrl';
import { runLegacy } from './appBootstrapCommand';
import { treeIsClean } from './gitTreeState';
import type { BootstrapBranchWiper, BootstrapGit, BootstrapGitHub } from './bootstrapPorts';

export function createRealBootstrapGit(repoDir: string): BootstrapGit & BootstrapBranchWiper {
  const git = (args: string[]): Promise<string> => runLegacy('git', args, repoDir);
  const bestEffortGit = async (args: string[]): Promise<void> => {
    try {
      await git(args);
    } catch {}
  };
  return {
    isCleanTree: async () => treeIsClean(await git(['status', '--porcelain'])),
    resolveBaseBranch: async () => {
      try {
        const out = await runLegacy(
          'gh',
          ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
          repoDir,
        );
        const name = out.trim();
        return name.length > 0 ? name : null;
      } catch {
        return null;
      }
    },
    branchExists: async (branch) => {
      const local = await git(['branch', '--list', branch]);
      if (local.trim().length > 0) return true;
      try {
        const remote = await runLegacy(
          'git',
          ['ls-remote', '--heads', 'origin', branch],
          repoDir,
        );
        return remote.trim().length > 0;
      } catch {
        return false;
      }
    },
    createBranchFromBase: async (branch, base) => {
      await git(['fetch', 'origin', base]);
      await git(['checkout', '-b', branch, 'FETCH_HEAD']);
    },
    commitEmptyStart: async (message) =>
      void (await git(['commit', '--allow-empty', '-m', message])),
    pushBranchUpstream: async (branch) =>
      void (await git(['push', '-u', 'origin', branch])),
    wipeConflictingBranch: async (branch) => {
      await bestEffortGit(['checkout', '--detach']);
      await bestEffortGit(['branch', '-D', branch]);
      await bestEffortGit(['push', 'origin', '--delete', branch]);
    },
  };
}

export function createRealBootstrapGitHub(repoDir: string): BootstrapGitHub {
  const gh = (args: string[]): Promise<string> => runLegacy('gh', args, repoDir);
  return {
    viewIssue: async (issue) => {
      try {
        const parsed = JSON.parse(
          await gh(['issue', 'view', String(issue), '--json', 'title,url']),
        );
        if (typeof parsed?.title === 'string' && typeof parsed?.url === 'string') {
          return { title: parsed.title, url: parsed.url };
        }
        return null;
      } catch {
        return null;
      }
    },
    assignIssueToSelf: async (issue) =>
      void (await gh(['issue', 'edit', String(issue), '--add-assignee', '@me'])),
    setIssueLabel: async (issue, label, on) =>
      void (await gh([
        'issue',
        'edit',
        String(issue),
        on ? '--add-label' : '--remove-label',
        label,
      ])),
    createDraftPr: async ({ base, head, title, body }) =>
      numberFromGithubUrl(
        await gh([
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
        ]),
      ),
    setPrLabel: async (pr, label, on) =>
      void (await gh([
        'pr',
        'edit',
        String(pr),
        on ? '--add-label' : '--remove-label',
        label,
      ])),
  };
}

