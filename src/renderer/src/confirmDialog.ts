// Destructive confirmation dialog (#26) — a placement-agnostic blocking dialog (UI-STANDARDS §5),
// NOT the §4 Alert live-region pattern. Composes createModalShell and supplies the todo-count
// message + Cancel/Terminate actions.

import { createModalShell } from './modalShell';

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

export function createConfirmDialog(host: HTMLElement): ConfirmDialog {
  const shell = createModalShell(host, 'confirm-dialog-title');
  return {
    render(opts) {
      if (!opts) return shell.render(null);
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
          close();
          run();
        });
        foot.append(cancel, confirm);
        card.append(foot);

        return { card, initialFocus: null, describedById };
      });
    },
    dispose() {
      shell.dispose();
    },
  };
}
