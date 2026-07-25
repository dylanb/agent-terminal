import type { ConfirmDialog } from './confirmDialog';

export interface TerminateConfirmDeps {
  todoList: (repoKey: string) => Promise<readonly unknown[]>;
  dialog: ConfirmDialog;
}

export interface TerminateConfirmationRequest {
  (
    repoKey: string,
    confirm: () => void,
    restoreFocusTo?: HTMLElement | null,
  ): void;
  cancelPending(): void;
}

export interface RepoChangeFocus {
  isAffected(): boolean;
  land(): void;
}

export function handleTerminateRepoChange(
  request: Pick<TerminateConfirmationRequest, 'cancelPending'> | undefined,
  repoKey: string,
  refresh: (repoKey: string) => void,
  focus?: RepoChangeFocus,
): void {
  const focusWasAffected = focus?.isAffected() ?? false;
  request?.cancelPending();
  refresh(repoKey);
  if (focusWasAffected) focus?.land();
}

export function createTerminateConfirm(
  deps: TerminateConfirmDeps,
): TerminateConfirmationRequest {
  let generation = 0;
  let dialogOpen = false;
  const cancelPending = (): void => {
    generation += 1;
    if (dialogOpen) {
      dialogOpen = false;
      deps.dialog.render(null);
    }
  };
  const request: TerminateConfirmationRequest = (
    repoKey,
    confirm,
    restoreFocusTo,
  ) => {
    const requestGeneration = ++generation;
    if (dialogOpen) {
      dialogOpen = false;
      deps.dialog.render(null);
    }
    void deps
      .todoList(repoKey)
      .then((todos) => {
        if (requestGeneration !== generation) return;
        const n = todos.length; // deterministic activation-time count (#26 AC3)
        dialogOpen = true;
        deps.dialog.render({
          title: 'Terminate flow',
          message: `This abandons the flow, deletes ${n} todo${n === 1 ? '' : 's'} for this repository, and clears captured reports for this terminal. The flow returns to Not started.`,
          confirmLabel: 'Terminate',
          restoreFocusTo,
          onConfirm: () => {
            if (requestGeneration !== generation) return;
            dialogOpen = false;
            generation += 1;
            confirm();
          },
          onCancel: () => {
            if (requestGeneration !== generation) return;
            dialogOpen = false;
            generation += 1;
          },
        });
      })
      .catch(() => {}); // a rejected count keeps the dialog closed, never an unhandled rejection
  };
  request.cancelPending = cancelPending;
  return request;
}
