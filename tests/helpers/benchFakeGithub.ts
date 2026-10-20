// An in-memory BenchGithub for the bench runner's tests (#180).

import type { BenchGithub } from '../../src/main/benchGithub';

/** The selector the fake answers for every folder: not the builder repositories' origin, so a value that reaches
 *  a fixture can only have come through the seam. */
export const FAKE_BENCH_REPOSITORY = 'github.com/bench-owner/bench-repo';

/** The number the fake gives its first copy; later copies count up from it. */
export const FAKE_FIRST_COPY = 501;

export interface FakeBenchGithubOptions {
  /** Whether the repository has the `bench-run` label, or creating it fails. Default `absent`. */
  label?: 'present' | 'absent' | 'create-fails';
  /** Shared with a fake launcher, so one log orders the GitHub calls among the launches. */
  events?: string[];
  /** Called on every `copyIssue`, so a test can move a fake clock during preparation. */
  onCopy?: () => void;
  /** The 1-based `copyIssue` call that fails (logged as `→ failed`, then rejected); none when absent. */
  failCopyAt?: number;
}

export interface FakeBenchGithub extends BenchGithub {
  /** Every call that is not `repositoryOf`, in order: `ensureBenchRunLabel <repo> → <result>`, `copyIssue <repo>#<n> → <copy>`. */
  writes: string[];
}

export function createFakeBenchGithub(opts: FakeBenchGithubOptions = {}): FakeBenchGithub {
  let label = opts.label ?? 'absent';
  let next = FAKE_FIRST_COPY;
  let copyCalls = 0;
  const writes: string[] = [];
  const log = (entry: string): void => {
    writes.push(entry);
    opts.events?.push(entry);
  };
  return {
    writes,
    repositoryOf: async () => FAKE_BENCH_REPOSITORY,
    ensureBenchRunLabel: async (repository) => {
      const result = label === 'present' ? 'existed' : label === 'absent' ? 'created' : 'failed';
      if (label === 'absent') label = 'present';
      log(`ensureBenchRunLabel ${repository} → ${result}`);
      return result;
    },
    copyIssue: async (source) => {
      if (++copyCalls === opts.failCopyAt) {
        log(`copyIssue ${source.repository}#${source.number} → failed`);
        throw new Error('fake: issue copy failed');
      }
      const copy = next++;
      opts.onCopy?.();
      log(`copyIssue ${source.repository}#${source.number} → ${copy}`);
      return copy;
    },
  };
}
