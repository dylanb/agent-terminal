import type { ConfirmDialogOptions } from './confirmDialog';

export interface AppBootstrapConflictDeps {
  onConflict(
    cb: (conflict: { branch: string; repoKey: string; step: string }) => void,
  ): () => void;
  confirm(opts: ConfirmDialogOptions): void;
  resolve(repoKey: string, step: string, wipe: boolean): void;
}

export function wireAppBootstrapConflict(
  deps: AppBootstrapConflictDeps,
): () => void {
  return deps.onConflict(({ branch, repoKey, step }) => {
    deps.confirm({
      title: 'Branch already exists',
      message: `A branch ${branch} already exists. Wiping deletes it locally and on origin and closes its PR. Wipe and retry?`,
      confirmLabel: 'Wipe and retry',
      onConfirm: () => deps.resolve(repoKey, step, true),
      onCancel: () => deps.resolve(repoKey, step, false),
    });
  });
}
