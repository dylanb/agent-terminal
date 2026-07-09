// Destructive confirmation dialog (#26) — a placement-agnostic blocking dialog (UI-STANDARDS §5),
// NOT the §4 Alert live-region pattern. Composes createModalShell and supplies the todo-count
// message + Cancel/Terminate actions.

import { createModalShell } from './modalShell';

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  /** Fired when the operator DECLINES — Cancel, Escape, or scrim — but never on confirm (§26.9). Lets a
   *  caller react to a dismissal (e.g. roll the flow back); omit when a dismiss needs no action. */
  onCancel?: () => void;
}

export interface ConfirmDialog {
  /** Open the dialog for `opts`; `null` closes any open dialog. */
  render(opts: ConfirmDialogOptions | null): void;
  /** Tear down: clear the host subtree on unmount/relocation (UI §2.2.1). */
  dispose(): void;
}

export function createConfirmDialog(host: HTMLElement, opts?: { onFocusLost?: () => void }): ConfirmDialog {
  // Track the open dialog's options + whether it was confirmed, so a user-dismiss (onClose fired by the
  // shell) runs onCancel while a confirm does not (§26.9). `pending` is non-null ONLY while a dialog is
  // open and unanswered — the shell's onClose nulls it — so a later render can tell an open-and-displaced
  // dialog (still pending) from an already-closed one (nulled), and never double-fires onCancel.
  let pending: ConfirmDialogOptions | null = null;
  let confirmed = false;
  const shell = createModalShell(
    host,
    'confirm-dialog-title',
    () => {
      if (!confirmed) pending?.onCancel?.();
      pending = null;
    },
    { onFocusLost: opts?.onFocusLost },
  );
  return {
    render(opts) {
      if (!opts) {
        pending = null;
        return shell.render(null);
      }
      // Replacing a still-open, unanswered dialog counts as declining it (§26.9): run its onCancel so a
      // rollback isn't dropped. shell.render(build) tears the old card down WITHOUT firing onClose, so this
      // is the only place the displaced dialog's cancellation is signalled.
      if (pending && !confirmed) pending.onCancel?.();
      pending = opts;
      confirmed = false;
      shell.render(({ doc, titleId, close }) => {
        const describedById = `${titleId}-msg`;
        const card = doc.createElement('div');
        card.className = 'card';
        const h3 = doc.createElement('h3');
        h3.className = 'serif';
        h3.id = titleId;
        h3.textContent = opts.title;
        const ph = doc.createElement('p');
        ph.className = 'ph';
        ph.id = describedById;
        ph.textContent = opts.message;
        card.append(h3, ph);

        const foot = doc.createElement('div');
        foot.className = 'mfoot';
        const cancel = doc.createElement('button');
        cancel.className = 'pill cancel';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', close);
        const confirm = doc.createElement('button');
        confirm.className = 'pill danger confirm';
        confirm.textContent = opts.confirmLabel;
        confirm.addEventListener('click', () => {
          const run = opts.onConfirm;
          confirmed = true; // suppress the shell's onClose → onCancel for this (confirmed) close
          close();
          run();
        });
        foot.append(cancel, confirm);
        card.append(foot);

        return { card, initialFocus: null, describedById };
      });
    },
    dispose() {
      pending = null; // teardown, not a dismiss: drop the pending dialog without firing onCancel
      shell.dispose();
    },
  };
}
