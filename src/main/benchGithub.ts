// #180 — the bench runner's GitHub seam.

export interface BenchGithub {
  /** The `host/owner/name` selector of the GitHub repository `repoDir` belongs to. */
  repositoryOf(repoDir: string): Promise<string>;
}

export function createBenchGithub(): BenchGithub {
  return { repositoryOf: async () => '' };
}
