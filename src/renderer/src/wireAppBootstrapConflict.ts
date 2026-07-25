import type { ConfirmDialogOptions } from './confirmDialog';
import type { AppBootstrapConflictTarget } from '../../shared/appBootstrap';

export interface AppBootstrapConflictDeps {
  onConflict(
    cb: (
      conflict: AppBootstrapConflictTarget & { repoKey: string; step: string },
    ) => void,
  ): () => void;
  confirm(opts: ConfirmDialogOptions): void;
  resolve(
    repoKey: string,
    step: string,
    wipe: boolean,
    target: AppBootstrapConflictTarget,
  ): void;
}

export function wireAppBootstrapConflict(
  deps: AppBootstrapConflictDeps,
): () => void {
  return deps.onConflict(({ repoKey, step, ...target }) => {
    const { repository, branch, localOid, remoteOid, pullRequests } = target;
    const resources: string[] = [];
    if (localOid !== null) {
      resources.push(`Delete local branch ${branch} (${localOid})`);
    }
    if (remoteOid !== null) {
      resources.push(`Delete origin branch ${branch} (${remoteOid})`);
    }
    resources.push(
      ...pullRequests.map(
        (pullRequest) => `Close pull request ${repository}#${pullRequest}`,
      ),
    );
    deps.confirm({
      title: 'Wipe existing resources?',
      message: `This will destroy ${resources.length} ${resources.length === 1 ? 'resource' : 'resources'}. It cannot be undone.`,
      resources,
      confirmLabel: 'Wipe and retry',
      role: 'alertdialog',
      onConfirm: () => deps.resolve(repoKey, step, true, target),
      onCancel: () => deps.resolve(repoKey, step, false, target),
    });
  });
}
