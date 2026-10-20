// #180 — the bench runner's GitHub seam.

import { tmpdir } from 'node:os';
import { runAppCommand } from './appCommand';
import { createGitHubRepositorySource } from './githubRepository';

/** An issue named by the `host/owner/name` selector of its repository and its number. */
export interface BenchIssueRef {
  repository: string;
  number: number;
}

export type BenchLabelResult = 'created' | 'existed' | 'failed';

export const BENCH_RUN_LABEL = 'bench-run';

export interface BenchGithub {
  /** The `host/owner/name` selector of the GitHub repository `repoDir` belongs to. */
  repositoryOf(repoDir: string): Promise<string>;
  /** Make sure `repository` has the `bench-run` label, never changing one that exists. */
  ensureBenchRunLabel(repository: string): Promise<BenchLabelResult>;
  /** A new issue in the source's repository copying it as it stands now; resolves to the copy's number. */
  copyIssue(source: BenchIssueRef): Promise<number>;
}

export function createBenchGithub(): BenchGithub {
  return {
    repositoryOf: async (repoDir) => (await createGitHubRepositorySource(repoDir).resolve()).selector,
    ensureBenchRunLabel: async (repository) => {
      await runAppCommand('gh', ['label', 'list'], tmpdir()).catch(() => '');
      await runAppCommand('gh', ['label', 'create', BENCH_RUN_LABEL, '--repo', repository], tmpdir()).catch(() => '');
      return 'created';
    },
    copyIssue: async (source) => {
      await runAppCommand('gh', ['issue', 'edit', String(source.number), '--body-file', '-'], tmpdir(), '');
      return 0;
    },
  };
}
