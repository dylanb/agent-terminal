export type AppBootstrapWipePolicy =
  | { mode: 'abort' }
  | { mode: 'wipe-and-retry' };

export interface AppBootstrapLabelMutation {
  action: 'add' | 'remove';
  target: 'issue' | 'pr';
  label: string;
}

export interface AppBootstrapConflictTarget {
  repository: string;
  branch: string;
  localOid: string | null;
  remoteOid: string | null;
  pullRequests: number[];
}

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

// One definition of what a git object id looks like: main normalizes oids onto the wire through
// parseAppGitObjectId and validates the renderer's echo of the same values through this module.
export function isGitObjectId(value: string): boolean {
  return OBJECT_ID.test(value);
}

function isConflictOid(value: unknown): boolean {
  return value === null || (typeof value === 'string' && isGitObjectId(value));
}

export function isAppBootstrapConflictTarget(
  value: unknown,
): value is AppBootstrapConflictTarget {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    typeof target.repository === 'string' &&
    target.repository.length > 0 &&
    typeof target.branch === 'string' &&
    target.branch.length > 0 &&
    isConflictOid(target.localOid) &&
    isConflictOid(target.remoteOid) &&
    Array.isArray(target.pullRequests) &&
    target.pullRequests.every(
      (pullRequest) =>
        Number.isSafeInteger(pullRequest) && (pullRequest as number) > 0,
    )
  );
}

export function hasAppBootstrapConflict(
  target: AppBootstrapConflictTarget,
): boolean {
  return (
    target.localOid !== null ||
    target.remoteOid !== null ||
    target.pullRequests.length > 0
  );
}

export function sameAppBootstrapConflictTarget(
  left: AppBootstrapConflictTarget,
  right: AppBootstrapConflictTarget,
): boolean {
  return (
    left.repository === right.repository &&
    left.branch === right.branch &&
    left.localOid === right.localOid &&
    left.remoteOid === right.remoteOid &&
    left.pullRequests.length === right.pullRequests.length &&
    left.pullRequests.every(
      (pullRequest, index) => pullRequest === right.pullRequests[index],
    )
  );
}

const BRANCH_NAME = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;
const REPOSITORY_PART = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

/** The branch names a pickup records, creates or checks out. */
export function isPickupBranchName(value: unknown): value is string {
  return typeof value === 'string' && BRANCH_NAME.test(value);
}

/** One `<owner>`, `<name>` or host part of a GitHub repository. */
export function isRepositoryPart(value: string): boolean {
  return REPOSITORY_PART.test(value) && value !== '.' && value !== '..';
}

/** `<owner>/<name>`, lowercased: the form a pickup records a repository in. */
export function isRepositoryName(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.toLowerCase()) return false;
  const parts = value.split('/');
  return parts.length === 2 && parts.every(isRepositoryPart);
}

/** A GitHub ticket: its repository travels with its number, since a head repository's numbers can collide with
 *  the base repository's. */
export interface TicketRef {
  repo: string;
  number: number;
}

const isTicketNumber = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

export function isTicketRef(value: unknown): value is TicketRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Record<string, unknown>;
  return Object.keys(ref).length === 2 && isRepositoryName(ref.repo) && isTicketNumber(ref.number);
}

export const sameTicketRef = (a: TicketRef, b: TicketRef): boolean => a.repo === b.repo && a.number === b.number;

/** The pickup of a run that adopted an existing pull request: it works on `fixBranch`, made at the PR head it
 *  fetched (`headOid`), and reviews the change from `baseOid`. */
export interface AdoptedPickup {
  kind: 'adopted';
  pr: number;
  /** origin's GitHub host, lowercased: the host every ticket and the PR are on. */
  host: string;
  fixBranch: string;
  /** The adopting run's Start instant, which `fixBranch` is derived from. */
  startedAt: number;
  headRef: string;
  baseRef: string;
  headRepo: string;
  crossRepository: boolean;
  tickets: TicketRef[];
  primary: TicketRef;
  headOid: string;
  baseOid: string;
}

/** The fix branch of the run started at `startedAt` on PR `pr`: unique per run, the same on a relaunch. */
export function adoptedFixBranch(pr: number, startedAt: number): string {
  return `agent-terminal/review-pr-${pr}-${startedAt}`;
}

/** The adopted pickup's fields as both pickup files store them. */
export function serializeAdoptedPickup(p: AdoptedPickup): Record<string, unknown> {
  return {
    kind: 'adopted',
    pr: p.pr,
    host: p.host,
    fix_branch: p.fixBranch,
    started_at: p.startedAt,
    head_ref: p.headRef,
    base_ref: p.baseRef,
    head_repo: p.headRepo,
    cross_repository: p.crossRepository,
    tickets: p.tickets.map((t) => ({ repo: t.repo, number: t.number })),
    primary: { repo: p.primary.repo, number: p.primary.number },
    head_oid: p.headOid,
    base_oid: p.baseOid,
  };
}

/** The adopted pickup a pickup file's mapping holds, or why it holds none. */
export function parseAdoptedPickup(doc: Record<string, unknown>): { ok: true; pickup: AdoptedPickup } | { ok: false; reason: string } {
  const bad = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
  const { pr, host, fix_branch, started_at, head_ref, base_ref, head_repo, cross_repository, tickets, primary, head_oid, base_oid } = doc;
  if (doc.kind !== 'adopted') return bad('is not an adopted pickup');
  if (!isTicketNumber(pr)) return bad('needs a positive integer pr');
  if (typeof host !== 'string' || host !== host.toLowerCase() || !isRepositoryPart(host)) return bad("needs origin's host, lowercased");
  if (typeof started_at !== 'number' || !Number.isSafeInteger(started_at) || started_at < 0) return bad('needs the run start as started_at');
  if (fix_branch !== adoptedFixBranch(pr, started_at)) return bad('has a fix_branch that is not the one its run derives');
  if (!isPickupBranchName(head_ref) || !isPickupBranchName(base_ref)) return bad('needs head_ref and base_ref branch names');
  if (!isRepositoryName(head_repo)) return bad('needs head_repo as <owner>/<name>');
  if (typeof cross_repository !== 'boolean') return bad('needs cross_repository true or false');
  if (!Array.isArray(tickets) || tickets.length === 0 || !tickets.every(isTicketRef)) return bad('needs at least one ticket, each {repo, number}');
  if (!isTicketRef(primary) || !tickets.some((t) => sameTicketRef(t, primary))) return bad('needs a primary that is one of its tickets');
  if (typeof head_oid !== 'string' || !isGitObjectId(head_oid) || typeof base_oid !== 'string' || !isGitObjectId(base_oid)) {
    return bad('needs head_oid and base_oid object ids');
  }
  return {
    ok: true,
    pickup: {
      kind: 'adopted',
      pr,
      host,
      fixBranch: fix_branch,
      startedAt: started_at,
      headRef: head_ref,
      baseRef: base_ref,
      headRepo: head_repo,
      crossRepository: cross_repository,
      tickets: tickets.map((t) => ({ repo: t.repo, number: t.number })),
      primary: { repo: primary.repo, number: primary.number },
      headOid: head_oid,
      baseOid: base_oid,
    },
  };
}

/** The pending form an adoption writes before it touches any ref. */
export function isAdoptedPickupIntent(doc: Record<string, unknown>): boolean {
  return doc.kind === 'adopted' && isTicketNumber(doc.pr) && isPickupBranchName(doc.fix_branch);
}

export function isAdoptedPickup<T extends object>(pickup: T | AdoptedPickup): pickup is AdoptedPickup {
  return 'kind' in pickup && pickup.kind === 'adopted';
}
