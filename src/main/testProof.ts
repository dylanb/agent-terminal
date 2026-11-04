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

const REFUSED = 1;
const RERUN = 'Fix that and run `pnpm run test:proof` again.';

export async function runTestProof(args: readonly string[], ports: TestProofPorts): Promise<number> {
  const refuse = (cause: string): number => {
    ports.report(`test:proof refused: ${cause}`);
    ports.report(RERUN);
    return REFUSED;
  };

  if (args.length > 0) {
    return refuse(
      `it takes no arguments, and was given ${args.map((arg) => JSON.stringify(arg)).join(' ')}. A proof is always the full vitest and e2e run.`,
    );
  }

  const branch = await ports.workingTree.branch();
  if (branch === null) return refuse('HEAD is detached, so it is not on a branch with an open PR.');

  const dirty = await ports.workingTree.dirtyPaths();
  if (dirty.length > 0) {
    return refuse(`the working tree is not clean (uncommitted or untracked): ${dirty.join(', ')}. Commit or remove them.`);
  }

  const pr = await ports.pullRequests.openFor(branch);
  switch (pr.kind) {
    case 'none':
      return refuse(`branch ${branch} has no open PR in this repository. Open one first.`);
    case 'several':
      return refuse(`branch ${branch} has several open PRs (${pr.numbers.map((n) => `#${n}`).join(', ')}). Close all but one.`);
    case 'fork':
      return refuse(`the open PR for branch ${branch}, #${pr.number}, is headed on a fork. Only a PR from a branch in this repository can be proved.`);
    case 'github-unavailable':
      return refuse(`GitHub is unavailable: ${pr.reason}`);
    case 'open':
      break;
  }

  const head = await ports.workingTree.head();
  if (head !== pr.headSha) {
    return refuse(`local HEAD ${head} is not the PR head: PR #${pr.number}'s head is ${pr.headSha}. Push HEAD, or check out the PR head.`);
  }

  ports.report(`test:proof: every precondition holds for PR #${pr.number} at ${head}, but running the suites is not built yet.`);
  return REFUSED;
}
