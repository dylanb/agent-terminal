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

function isConflictOid(value: unknown): boolean {
  return value === null || (typeof value === 'string' && OBJECT_ID.test(value));
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
