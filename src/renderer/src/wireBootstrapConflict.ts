// §26.9 — the bootstrap-conflict confirm wiring. The operator's answer (wipe / cancel-and-roll-back) is
// bound to the repo the conflict was RAISED for, carried on the `flow:onBootstrapConflict` push, never the
// terminal's current cwd: a conflict for repo A can arrive after the user has cd'd to repo B, and answering
// with B's key would drive a DESTRUCTIVE wipe (deletes the branch on origin, closes its PR) at the wrong
// repo — or no-op. The deps name the domain concepts (subscribe / confirm / resolve), not the IPC seam.
import type { ConfirmDialogOptions } from './confirmDialog';

export interface BootstrapConflictDeps {
  onBootstrapConflict: (cb: (branch: string, repoKey: string) => void) => () => void;
  confirm: (opts: ConfirmDialogOptions) => void;
  resolve: (repoKey: string, wipe: boolean) => void;
}

export function wireBootstrapConflict(deps: BootstrapConflictDeps): () => void {
  return deps.onBootstrapConflict((branch, repoKey) => {
    deps.confirm({
      title: 'Branch already exists',
      message: `A branch ${branch} already exists. Wiping deletes it on origin and closes its PR. Wipe and retry?`,
      confirmLabel: 'Wipe and retry',
      onConfirm: () => deps.resolve(repoKey, true),
      onCancel: () => deps.resolve(repoKey, false),
    });
  });
}
