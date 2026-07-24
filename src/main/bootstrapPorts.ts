import { execFile } from 'node:child_process';
import { APP_STATE_DIRS } from './appStateDirs';
import { numberFromGithubUrl } from '../shared/githubUrl';
import { isRecord } from './yamlRecord';

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
  createDraftPr(args: {
    base: string;
    head: string;
    title: string;
    body: string;
  }): Promise<number | null>;
  setPrLabel(pr: number, label: string, on: boolean): Promise<void>;
}

const EXEC_TIMEOUT_MS = 60_000;

function runLegacy(
  file: 'git' | 'gh',
  args: string[],
  cwd: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd, timeout: EXEC_TIMEOUT_MS },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

const APP_STATE_PREFIXES = APP_STATE_DIRS.map((dir) => `${dir}/`);

function treeIsClean(porcelain: string): boolean {
  const isAppState = (path: string): boolean =>
    APP_STATE_PREFIXES.some((prefix) => path.startsWith(prefix));
  return porcelain
    .split('\n')
    .filter((line) => line.length > 0)
    .every((line) =>
      line.slice(3).split(' -> ').every(isAppState),
    );
}

export function createRealBootstrapGit(
  repoDir: string,
): BootstrapGit & BootstrapBranchWiper & BootstrapBranchRollback {
  const git = (args: string[]): Promise<string> =>
    runLegacy('git', args, repoDir);
  const bestEffortGit = async (args: string[]): Promise<void> => {
    try {
      await git(args);
    } catch {
      // §26.9.
    }
  };
  return {
    isCleanTree: async () =>
      treeIsClean(await git(['status', '--porcelain'])),
    resolveBaseBranch: async () => {
      try {
        const output = await runLegacy(
          'gh',
          [
            'repo',
            'view',
            '--json',
            'defaultBranchRef',
            '--jq',
            '.defaultBranchRef.name',
          ],
          repoDir,
        );
        return output.trim() || null;
      } catch {
        return null;
      }
    },
    branchExists: async (branch) => {
      if ((await git(['branch', '--list', branch])).trim().length > 0) {
        return true;
      }
      try {
        return (
          await git(['ls-remote', '--heads', 'origin', branch])
        ).trim().length > 0;
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
      if ((await git(['branch', '--list', branch])).trim().length > 0) {
        await git(['checkout', '--detach']);
        await git(['branch', '-D', branch]);
      }
      if (
        (
          await git(['ls-remote', '--heads', 'origin', branch])
        ).trim().length > 0
      ) {
        await git(['push', 'origin', '--delete', branch]);
      }
    },
    createBranchFromBase: async (branch, base) => {
      await git(['fetch', 'origin', base]);
      await git(['checkout', '-b', branch, 'FETCH_HEAD']);
    },
    commitEmptyStart: async (message) => {
      await git(['commit', '--allow-empty', '-m', message]);
    },
    pushBranchUpstream: async (branch) => {
      await git(['push', '-u', 'origin', branch]);
    },
  };
}

export function createRealBootstrapGitHub(
  repoDir: string,
): BootstrapGitHub {
  const gh = (args: string[]): Promise<string> =>
    runLegacy('gh', args, repoDir);
  return {
    viewIssue: async (issue) => {
      try {
        const parsed: unknown = JSON.parse(
          await gh([
            'issue',
            'view',
            String(issue),
            '--json',
            'title,url',
          ]),
        );
        return isRecord(parsed) &&
          typeof parsed.title === 'string' &&
          typeof parsed.url === 'string'
          ? { title: parsed.title, url: parsed.url }
          : null;
      } catch {
        return null;
      }
    },
    assignIssueToSelf: async (issue) => {
      await gh([
        'issue',
        'edit',
        String(issue),
        '--add-assignee',
        '@me',
      ]);
    },
    setIssueLabel: async (issue, label, on) => {
      await gh([
        'issue',
        'edit',
        String(issue),
        on ? '--add-label' : '--remove-label',
        label,
      ]);
    },
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
    setPrLabel: async (pullRequest, label, on) => {
      await gh([
        'pr',
        'edit',
        String(pullRequest),
        on ? '--add-label' : '--remove-label',
        label,
      ]);
    },
  };
}
