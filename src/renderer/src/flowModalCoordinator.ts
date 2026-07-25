import type { ConfirmDialog, ConfirmDialogOptions } from './confirmDialog';
import type { ErrorDialog, ErrorDialogOptions } from './errorDialog';

export interface FlowModalCoordinator {
  showError(options: ErrorDialogOptions): void;
  showConfirmation(options: ConfirmDialogOptions): void;
  cancelConfirmation(): void;
}

export function createFlowModalCoordinator(deps: {
  errors?: ErrorDialog;
  confirmations?: ConfirmDialog;
  cancelPendingConfirmation: () => void;
}): FlowModalCoordinator {
  const cancelConfirmation = (): void => {
    deps.cancelPendingConfirmation();
    deps.confirmations?.cancel();
  };
  return {
    showError(options) {
      cancelConfirmation();
      deps.errors?.render(options);
    },
    showConfirmation(options) {
      deps.cancelPendingConfirmation();
      deps.errors?.render(null);
      deps.confirmations?.render(options);
    },
    cancelConfirmation,
  };
}
