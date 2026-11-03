export type OpenPullRequest =
  | { kind: 'open'; number: number; headSha: string }
  | { kind: 'none' }
  | { kind: 'several'; numbers: number[] }
  | { kind: 'fork'; number: number }
  | { kind: 'github-unavailable'; reason: string };

export interface ProofWorkingTree {
  dirtyPaths(): Promise<string[]>;
  head(): Promise<string>;
  branch(): Promise<string | null>;
}

export interface BranchPullRequests {
  openFor(branch: string): Promise<OpenPullRequest>;
}

export interface TestProofPorts {
  workingTree: ProofWorkingTree;
  pullRequests: BranchPullRequests;
  report(line: string): void;
}

export async function runTestProof(_args: readonly string[], _ports: TestProofPorts): Promise<number> {
  return 0;
}
