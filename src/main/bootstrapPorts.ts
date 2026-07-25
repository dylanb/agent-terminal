
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

export interface AppBootstrapGit {
  isCleanTree(): Promise<boolean>;
  resolveBaseBranch(): Promise<string | null>;
  branchExists(branch: string): Promise<boolean>;
  createBranchFromBase(branch: string, base: string): Promise<void>;
  commitEmptyStart(message: string): Promise<string>;
  pushBranchUpstream(branch: string, ownedOid: string): Promise<string>;
  rollbackCreatedBranch(branch: string, ownedOid: string | null): Promise<void>;
}

export interface AppBootstrapGitFaults {
  currentCheckoutResult?: () => Error | null;
  branchCreationResult?: () => Error | null;
  checkoutResult?: () => Error | null;
  startCommitResult?: () => Error | null;
  pushResult?: () => Error | null;
}

export type OwnedPrLookup =
  | { kind: 'owned'; number: number }
  | { kind: 'absent' }
  | { kind: 'foreign' };

export interface BootstrapBranchWiper {
  wipeConflictingBranch(branch: string): Promise<void>;
}

export interface BootstrapGitHub {
  viewIssue(issue: number): Promise<BootstrapIssue | null>;
  assignIssueToSelf(issue: number): Promise<void>;
  setIssueLabel(issue: number, label: string, on: boolean): Promise<void>;
  createDraftPr(args: { base: string; head: string; title: string; body: string }): Promise<number | null>;
  setPrLabel(pr: number, label: string, on: boolean): Promise<void>;
}

export interface AppBootstrapGitHub {
  viewIssue(issue: number): Promise<BootstrapIssue | null>;
  assignIssueToSelf(issue: number): Promise<void>;
  setIssueLabel(issue: number, label: string, on: boolean): Promise<void>;
  createDraftPr(args: { base: string; head: string; title: string; body: string }): Promise<number>;
  findOwnedOpenPr(args: { base: string; head: string; marker: string }): Promise<OwnedPrLookup>;
  closePr(pr: number): Promise<void>;
  setPrLabel(pr: number, label: string, on: boolean): Promise<void>;
}

export class AmbiguousBootstrapOperationError extends Error {}
export class OwnedBootstrapBranchError extends Error {}
export class UnresolvedRemoteBootstrapBranchError extends Error {}

