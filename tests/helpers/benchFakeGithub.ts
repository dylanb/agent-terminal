// An in-memory BenchGithub for the bench runner's tests (#180).

import type { BenchGithub } from '../../src/main/benchGithub';

/** The selector the fake answers for every folder: not the builder repositories' origin, so a value that reaches
 *  a fixture can only have come through the seam. */
export const FAKE_BENCH_REPOSITORY = 'github.com/bench-owner/bench-repo';

export function createFakeBenchGithub(): BenchGithub {
  return { repositoryOf: async () => FAKE_BENCH_REPOSITORY };
}
