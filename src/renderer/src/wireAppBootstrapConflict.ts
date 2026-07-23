import type { ConfirmDialogOptions } from './confirmDialog';
import type { AppBootstrapConflictTarget } from '../../shared/appBootstrap';

export interface AppBootstrapConflictDeps {
  onConflict(
    cb: (
      conflict: AppBootstrapConflictTarget & { repoKey: string; step: string },
    ) => void,
  ): () => void;
  confirm(opts: ConfirmDialogOptions): void;
  resolve(repoKey: string, step: string, wipe: boolean): void;
}

export function wireAppBootstrapConflict(
  deps: AppBootstrapConflictDeps,
): () => void {
  return deps.onConflict(({
    branch,
    localOid,
    remoteOid,
    pullRequests,
    repoKey,
    step,
  }) => {
    const resources: string[] = [];
    if (localOid !== null) {
      resources.push(`local branch ${branch} at ${localOid}`);
    }
    if (remoteOid !== null) {
      resources.push(`origin branch ${branch} at ${remoteOid}`);
    }
    resources.push(
      ...pullRequests.map((pullRequest) => `pull request #${pullRequest}`),
    );
    deps.confirm({
      title: 'Bootstrap resources already exist',
      message: `Wiping will delete or close exactly: ${resources.join(', ')}. Wipe and retry?`,
      confirmLabel: 'Wipe and retry',
      onConfirm: () => deps.resolve(repoKey, step, true),
      onCancel: () => deps.resolve(repoKey, step, false),
    });
  });
}
