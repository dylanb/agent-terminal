// Composition-root Terminate seam (#26 AC3): surfaces the repo's activation-time todo count in the
// destructive confirmation and gates the IPC terminate behind the user's confirm. Extracted from the
// root so the count derivation + count message live where they are unit-testable — the strip stays
// flow-only (§9.1); the root owns the window.monitor todo count.

import type { ConfirmDialog } from './confirmDialog';

export interface TerminateConfirmDeps {
  /** The repo's current todos; only its length is read (the deterministic activation-time count). */
  todoList: (repoKey: string) => Promise<readonly unknown[]>;
  dialog: ConfirmDialog;
}

/** Build the strip's `onTerminate(repoKey, confirm)` seam: open the confirmation for the repo's
 *  current todo count, wiring the user's `confirm` as the dialog's onConfirm. */
export function createTerminateConfirm(
  deps: TerminateConfirmDeps,
): (repoKey: string, confirm: () => void) => void {
  return (repoKey, confirm) => {
    void deps
      .todoList(repoKey)
      .then((todos) => {
        const n = todos.length; // deterministic activation-time count (#26 AC3)
        deps.dialog.render({
          title: 'Terminate flow',
          message: `This abandons the flow and deletes ${n} todo${n === 1 ? '' : 's'} for this repository. The flow returns to Not started.`,
          confirmLabel: 'Terminate',
          onConfirm: confirm,
        });
      })
      .catch(() => {}); // a rejected count keeps the dialog closed, never an unhandled rejection
  };
}
