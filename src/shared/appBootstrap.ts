export type AppBootstrapWipePolicy =
  | { mode: 'abort' }
  | { mode: 'wipe-and-retry' };

export interface AppBootstrapLabelMutation {
  action: 'add' | 'remove';
  target: 'issue' | 'pr';
  label: string;
}

export interface AppBootstrapConflictTarget {
  branch: string;
  localOid: string | null;
  remoteOid: string | null;
  pullRequests: number[];
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
    left.branch === right.branch &&
    left.localOid === right.localOid &&
    left.remoteOid === right.remoteOid &&
    left.pullRequests.length === right.pullRequests.length &&
    left.pullRequests.every(
      (pullRequest, index) => pullRequest === right.pullRequests[index],
    )
  );
}
