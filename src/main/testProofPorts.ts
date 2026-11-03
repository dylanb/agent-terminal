import type { BranchPullRequests, OpenPullRequest, ProofWorkingTree } from './testProof';

export function createProofWorkingTree(_root: string): ProofWorkingTree {
  return {
    dirtyPaths: async () => [],
    head: async () => '',
    branch: async () => '',
  };
}

export function createBranchPullRequests(_root: string): BranchPullRequests {
  return {
    openFor: async (): Promise<OpenPullRequest> => ({ kind: 'several', numbers: [] }),
  };
}
