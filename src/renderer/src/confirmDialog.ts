// Destructive confirmation dialog (#26) — a placement-agnostic modal-dialog organism (UI-STANDARDS
// §1.2), NOT the §4 Alert live-region pattern: focus trap, role=dialog, focus move-in + restore. The
// opener decides WHEN to open/close it (render(opts|null)). STUB — render is a no-op until implemented.

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
}

export interface ConfirmDialog {
  /** Open the dialog for `opts`; `null` closes any open dialog. */
  render(opts: ConfirmDialogOptions | null): void;
  /** Tear down: clear the host subtree on unmount/relocation (UI §2.2.1). */
  dispose(): void;
}

export function createConfirmDialog(_host: HTMLElement): ConfirmDialog {
  return {
    render() {
      /* STUB (#26) */
    },
    dispose() {
      /* STUB (#26) */
    },
  };
}
