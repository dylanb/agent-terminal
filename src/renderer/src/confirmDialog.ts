// Destructive confirmation dialog (#26) — a placement-agnostic blocking dialog (UI-STANDARDS §5),
// NOT the §4 Alert live-region pattern.

import { createModalShell } from './modalShell';

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel: string;
  /** Discrete items the action acts on; each is its own navigable node in the dialog's accessible
   *  description, so an irreversible confirmation is never announced as a bare count (WCAG 1.3.1). */
  resources?: string[];
  onConfirm: () => void;
  restoreFocusTo?: HTMLElement | null;
  /** WAI-ARIA APG / UI-STANDARDS §5.2: `alertdialog` when the app raised this without the operator
   *  asking, `dialog` (the default) when they did. */
  role?: 'dialog' | 'alertdialog';
  /** Fired when the operator DECLINES — Cancel, Escape, or scrim — but never on confirm (§26.9). Lets a
   *  caller react to a dismissal (e.g. roll the flow back); omit when a dismiss needs no action. */
  onCancel?: () => void;
}

export interface ConfirmDialog {
  /** Open the dialog for `opts`; `null` closes any open dialog. */
  render(opts: ConfirmDialogOptions | null): void;
  cancel(): void;
  /** Tear down: clear the host subtree on unmount/relocation (UI §2.2.1). */
  dispose(): void;
}

export function createConfirmDialog(host: HTMLElement, opts?: { onFocusLost?: () => void }): ConfirmDialog {
  // `pending` is non-null ONLY while a dialog is open and UNANSWERED, so a later render can tell an
  // open-and-displaced dialog (still pending) from an already-answered one (nulled), and never
  // double-fires onCancel (§26.9). The shell's `confirm` path does not fire onDismiss, so an accept is not
  // mistaken for a dismissal.
  let pending: ConfirmDialogOptions | null = null;
  const shell = createModalShell(
    host,
    'confirm-dialog-title',
    () => {
      pending?.onCancel?.();
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
      // rollback isn't dropped. shell.render(build) tears the old card down WITHOUT firing onDismiss, so this
      // is the only place the displaced dialog's cancellation is signalled.
      if (pending) pending.onCancel?.();
      pending = opts;
      shell.render(({ doc, titleId, close, confirm: accept }) => {
        const messageId = `${titleId}-msg`;
        let describedById = messageId;
        const card = doc.createElement('div');
        card.className = 'card';
        const h3 = doc.createElement('h3');
        h3.className = 'serif';
        h3.id = titleId;
        h3.textContent = opts.title;
        // UI §5.7
        const body = doc.createElement('div');
        const ph = doc.createElement('p');
        ph.className = 'ph';
        ph.id = messageId;
        ph.textContent = opts.message;
        body.append(ph);
        if (opts.resources !== undefined && opts.resources.length > 0) {
          const list = doc.createElement('ul');
          list.className = 'cd-resources';
          list.id = `${titleId}-res`;
          describedById = `${messageId} ${list.id}`;
          for (const resource of opts.resources) {
            const item = doc.createElement('li');
            item.textContent = resource;
            list.append(item);
          }
          body.append(list);
        }
        card.append(h3, body);

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
          pending = null; // answered, so neither this close nor a later render may fire onCancel
          accept();
          run();
        });
        foot.append(cancel, confirm);
        card.append(foot);

        return {
          card,
          initialFocus: null,
          describedById,
          grow: body,
          scroll: body,
          ...(opts.role ? { role: opts.role } : {}),
        };
      }, opts.restoreFocusTo);
    },
    cancel() {
      const onCancel = pending?.onCancel;
      pending = null;
      shell.render(null);
      onCancel?.();
    },
    dispose() {
      pending = null; // teardown, not a dismiss: drop the pending dialog without firing onCancel
      shell.dispose();
    },
  };
}
