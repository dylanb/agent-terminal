// #180 — the bench runner's GitHub seam. Every value crosses to `gh` as an argv element or on stdin (CWE-78), and
// every call is pinned to the repository it acts on with `--repo`.

import { tmpdir } from 'node:os';
import { runAppCommand } from './appCommand';
import { EPIC_READY_LABEL } from './epicPromotion';
import { errMsg } from './errno';
import { ensureGithubLabel, type PinnedGh } from './githubLabel';
import { createGitHubRepositorySource } from './githubRepository';
import { numberFromGithubUrl } from '../shared/githubUrl';

/** An issue named by the `host/owner/name` selector of its repository and its number. */
export interface BenchIssueRef {
  repository: string;
  number: number;
}

export type BenchLabelResult = 'created' | 'existed' | 'failed';

export const BENCH_RUN_LABEL = 'bench-run';
export const BENCH_RUN_LABEL_DESCRIPTION = 'An issue copy made by a Bench-1 re-run (#180)';

export interface BenchGithub {
  /** The `host/owner/name` selector of the GitHub repository `repoDir` belongs to. */
  repositoryOf(repoDir: string): Promise<string>;
  /** Make sure `repository` has the `bench-run` label, never changing one that exists. */
  ensureBenchRunLabel(repository: string): Promise<BenchLabelResult>;
  /** A new issue in the source's repository copying it as it stands now; resolves to the copy's number. */
  copyIssue(source: BenchIssueRef): Promise<number>;
}

interface SourceIssue {
  title: string;
  body: string;
  labels: string[];
  comments: { author: string; createdAt: string; body: string }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseSourceIssue(text: string): SourceIssue {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  if (!isRecord(raw) || typeof raw.title !== 'string' || typeof raw.body !== 'string' || !Array.isArray(raw.labels) || !Array.isArray(raw.comments)) {
    throw new Error('the source issue was not recognized');
  }
  const labels = raw.labels.map((l) => {
    if (!isRecord(l) || typeof l.name !== 'string') throw new Error('a source issue label was not recognized');
    return l.name;
  });
  const comments = raw.comments.map((c) => {
    if (!isRecord(c) || !isRecord(c.author) || typeof c.author.login !== 'string' || typeof c.createdAt !== 'string' || typeof c.body !== 'string') {
      throw new Error('a source issue comment was not recognized');
    }
    return { author: c.author.login, createdAt: c.createdAt, body: c.body };
  });
  return { title: raw.title, body: raw.body, labels, comments };
}

/** The author line names the login without `@`, so the attribution itself notifies no one. */
const copiedComment = (c: SourceIssue['comments'][number]): string => `Copied from a comment by ${c.author} at ${c.createdAt}.\n\n${c.body}`;

export function createBenchGithub(): BenchGithub {
  const run = async (repository: string, args: string[], failure: string, stdin?: string): Promise<string> => {
    try {
      return await runAppCommand('gh', [...args, '--repo', repository], tmpdir(), stdin);
    } catch (e) {
      throw new Error(`${failure}: ${errMsg(e)}`);
    }
  };
  const pinned =
    (repository: string): PinnedGh =>
    (args, failure) =>
      run(repository, args, failure);
  return {
    repositoryOf: async (repoDir) => (await createGitHubRepositorySource(repoDir).resolve()).selector,
    ensureBenchRunLabel: async (repository) => {
      try {
        return await ensureGithubLabel(pinned(repository), BENCH_RUN_LABEL, BENCH_RUN_LABEL_DESCRIPTION);
      } catch {
        return 'failed';
      }
    },
    copyIssue: async ({ repository, number }) => {
      const source = parseSourceIssue(await run(repository, ['issue', 'view', String(number), '--json', 'title,body,labels,comments'], 'source issue read failed'));
      const labels = [...source.labels.filter((l) => l !== EPIC_READY_LABEL && l !== BENCH_RUN_LABEL), BENCH_RUN_LABEL];
      const created = await run(repository, ['issue', 'create', '--title', source.title, '--body-file', '-', ...labels.flatMap((l) => ['--label', l])], 'issue copy failed', source.body);
      const copy = numberFromGithubUrl(created);
      if (copy === null || copy === number) throw new Error('issue copy outcome was not recognized');
      for (const comment of source.comments) {
        await run(repository, ['issue', 'comment', String(copy), '--body-file', '-'], 'comment copy failed', copiedComment(comment));
      }
      return copy;
    },
  };
}
