// Destructive confirmation dialog (#26) — a placement-agnostic modal-dialog organism (UI-STANDARDS
// §1.2), NOT the §4 Alert live-region pattern: focus trap, role=dialog, focus move-in + restore. The
// opener decides WHEN to open/close it (render(opts|null)).

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

let confirmSeq = 0; // instance-unique title id: two dialogs in one document must not collide (WCAG 4.1.2)

export function createConfirmDialog(host: HTMLElement): ConfirmDialog {
  const doc = host.ownerDocument; // host's document, not global — relocation (UI §2.2.1)
  const titleId = `confirm-dialog-title-${confirmSeq++}`;
  const msgId = `confirm-dialog-msg-${confirmSeq++}`;
  let opener: HTMLElement | null = null; // focus to restore on close (WCAG 2.4.3)
  const close = (): void => {
    host.replaceChildren();
    opener?.focus();
    opener = null;
  };
  return {
    render(opts) {
      if (!opts) return close();
      const wasOpen = host.firstChild !== null;
      host.replaceChildren();
      if (!wasOpen) opener = doc.activeElement as HTMLElement | null;

      const scrim = doc.createElement('div');
      scrim.className = 'flow-scrim';
      scrim.addEventListener('click', close);

      const modal = doc.createElement('div');
      modal.className = 'flow-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-labelledby', titleId);
      modal.setAttribute('aria-describedby', msgId);
      modal.tabIndex = -1; // focus lands on the container, with no action pre-focused (WCAG 2.4.3)
      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') return close();
        if (e.key === 'Tab') {
          const f = [...modal.querySelectorAll<HTMLElement>('button')].filter((el) => !el.hasAttribute('disabled'));
          if (f.length === 0) return;
          const first = f[0];
          const last = f[f.length - 1];
          const active = doc.activeElement;
          if (e.shiftKey && (active === first || active === modal)) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && active === last) {
            e.preventDefault();
            first.focus();
          }
        }
      });

      const card = doc.createElement('div');
      card.className = 'card';
      const h3 = doc.createElement('h3');
      h3.className = 'serif';
      h3.id = titleId;
      h3.textContent = opts.title;
      const ph = doc.createElement('p');
      ph.className = 'ph';
      ph.id = msgId;
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

      modal.append(card);
      host.append(scrim, modal);
      modal.focus();
    },
    // Teardown drops the host subtree (all listeners live inside it) and clears opener WITHOUT
    // close(), which would wrongly restore focus on unmount/relocation (UI §2.2.1).
    dispose() {
      host.replaceChildren();
      opener = null;
    },
  };
}
