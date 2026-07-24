import { execFile } from 'node:child_process';
import { APP_STATE_DIRS } from './appStateDirs';
import { numberFromGithubUrl } from '../shared/githubUrl';

export interface BootstrapIssue {
  title: string;
  url: string;
}

export interface BootstrapGit {
  isCleanTree(): Promise<boolean>;
  resolveBaseBranch(): Promise<string | null>;
  branchExists(branch: string): Promise<boolean>;
  createBranchFromBase(branch: string, base: string): Promise<void>;
  commitEmptyStart(message: string): Promise<void>;
  pushBranchUpstream(branch: string): Promise<void>;
}

export interface BootstrapBranchWiper {
  wipeConflictingBranch(branch: string): Promise<void>;
}

export interface BootstrapBranchRollback {
  rollbackCreatedBranch(branch: string): Promise<void>;
}

export interface BootstrapGitHub {
  viewIssue(issue: number): Promise<BootstrapIssue | null>;
  assignIssueToSelf(issue: number): Promise<void>;
  setIssueLabel(issue: number, label: string, on: boolean): Promise<void>;
  createDraftPr(args: { base: string; head: string; title: string; body: string }): Promise<number | null>;
  setPrLabel(pr: number, label: string, on: boolean): Promise<void>;
}

const EXEC_TIMEOUT_MS = 60_000;

function run(file: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

const APP_STATE_PREFIXES = APP_STATE_DIRS.map((d) => `${d}/`);

function treeIsClean(porcelain: string): boolean {
  const isAppState = (p: string): boolean => APP_STATE_PREFIXES.some((prefix) => p.startsWith(prefix));
  return porcelain
    .split('\n')
    .filter((line) => line.length > 0)
    .every((line) => line.slice(3).split(' -> ').every(isAppState));
}

export function createRealBootstrapGit(repoDir: string): BootstrapGit & BootstrapBranchWiper & BootstrapBranchRollback {
  const git = (args: string[]): Promise<string> => run('git', args, repoDir);
  const bestEffortGit = async (args: string[]): Promise<void> => {
    try {
      await git(args);
    } catch {
      // A branch already absent on one side of cleanup is the target state.
    }
  };
  return {
    isCleanTree: async () => treeIsClean(await git(['status', '--porcelain'])),
    resolveBaseBranch: async () => {
      try {
        const out = await run('gh', ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'], repoDir);
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
        const remote = await run('git', ['ls-remote', '--heads', 'origin', branch], repoDir);
        return remote.trim().length > 0;
      } catch {
        return false;
      }
    },
    wipeConflictingBranch: async (branch) => {
      await bestEffortGit(['checkout', '--detach']);
      await bestEffortGit(['branch', '-D', branch]);
      await bestEffortGit(['push', 'origin', '--delete', branch]);
    },
    rollbackCreatedBranch: async (branch) => {
      const local = await git(['branch', '--list', branch]);
      if (local.trim().length > 0) {
        await git(['checkout', '--detach']);
        await git(['branch', '-D', branch]);
      }
      const remote = await git(['ls-remote', '--heads', 'origin', branch]);
      if (remote.trim().length > 0) {
        await git(['push', 'origin', '--delete', branch]);
      }
    },
    createBranchFromBase: async (branch, base) => {
      await git(['fetch', 'origin', base]);
      await git(['checkout', '-b', branch, 'FETCH_HEAD']);
    },
    commitEmptyStart: async (message) => void (await git(['commit', '--allow-empty', '-m', message])),
    pushBranchUpstream: async (branch) => void (await git(['push', '-u', 'origin', branch])),
  };
}

export function createRealBootstrapGitHub(repoDir: string): BootstrapGitHub {
  const gh = (args: string[]): Promise<string> => run('gh', args, repoDir);
  return {
    viewIssue: async (issue) => {
      try {
        const parsed = JSON.parse(await gh(['issue', 'view', String(issue), '--json', 'title,url']));
        if (typeof parsed?.title === 'string' && typeof parsed?.url === 'string') {
          return { title: parsed.title, url: parsed.url };
        }
        return null;
      } catch {
        return null;
      }
    },
    assignIssueToSelf: async (issue) => void (await gh(['issue', 'edit', String(issue), '--add-assignee', '@me'])),
    setIssueLabel: async (issue, label, on) =>
      void (await gh(['issue', 'edit', String(issue), on ? '--add-label' : '--remove-label', label])),
    createDraftPr: async ({ base, head, title, body }) => {
      const out = await gh(['pr', 'create', '--draft', '--base', base, '--head', head, '--title', title, '--body', body]);
      return numberFromGithubUrl(out);
    },
    setPrLabel: async (pr, label, on) =>
      void (await gh(['pr', 'edit', String(pr), on ? '--add-label' : '--remove-label', label])),
  };
}
