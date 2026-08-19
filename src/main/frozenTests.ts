// STUB (RED): surface present, detects nothing yet.
export interface FrozenTestsQuery {
  repoDir: string;
  baseline: string;
  head: string;
  testGlobs: readonly string[];
}
export async function changedTestPaths(query: FrozenTestsQuery): Promise<string[]> {
  void query;
  return [];
}
