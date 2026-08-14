// Blocking error-alert dialog (§27.10) — a placement-agnostic blocking dialog (UI-STANDARDS §5), NOT the
// §4 Alert live-region pattern. Raised when an async bootstrap fails (a pickup that could not run) so the
// failure is never silent. Composes createModalShell (shared focus trap) and, unlike confirmDialog,
// carries no destructive action — a single Dismiss acknowledges it. The title and message can carry
// repo-authored bytes (a repo-tier def's branch_template / a step id reach this surface), so both sinks
// neutralise through the one shared display-control strip before render (CWE-117, §16.3).

import { stripDisplayControlChars } from '../../shared/controlChars';
import { createModalShell } from './modalShell';

export interface ErrorDialogOptions {
  title: string;
  message: string;
}

export interface ErrorDialog {
  /** Open the dialog for `opts`; `null` closes any open dialog. */
  render(opts: ErrorDialogOptions | null): void;
  /** Tear down: clear the host subtree on unmount/relocation (UI §2.2.1). */
  dispose(): void;
}

export function createErrorDialog(host: HTMLElement, opts?: { onFocusLost?: () => void }): ErrorDialog {
  // WAI-ARIA APG: main pushes this dialog on a failure the user never asked for — an urgent interruption.
  const shell = createModalShell(host, 'error-dialog-title', undefined, {
    role: 'alertdialog',
    onFocusLost: opts?.onFocusLost,
  });
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
        h3.textContent = stripDisplayControlChars(opts.title);
        const ph = doc.createElement('p');
        ph.className = 'ph';
        ph.id = describedById;
        ph.textContent = stripDisplayControlChars(opts.message);
        card.append(h3, ph);

        const foot = doc.createElement('div');
        foot.className = 'mfoot';
        const dismiss = doc.createElement('button');
        dismiss.className = 'pill dismiss';
        dismiss.textContent = 'Dismiss';
        dismiss.addEventListener('click', close);
        foot.append(dismiss);
        card.append(foot);

        return { card, initialFocus: null, describedById };
      });
    },
    dispose() {
      shell.dispose();
    },
  };
}
