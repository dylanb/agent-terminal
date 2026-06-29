// Reusable modal-dialog shell (#26): the one definition of the blocking-dialog focus management
// (UI-STANDARDS §5), composed by confirmDialog and flowInputModal so the focus-trap logic cannot
// diverge between them. Callers supply only the card body via render(build).

export interface ModalCard {
  card: HTMLElement;
  initialFocus: HTMLElement | null;
  describedById?: string;
}

export type ModalShellBuild = (ctx: {
  doc: Document;
  titleId: string;
  close: () => void;
}) => ModalCard;

export interface ModalShell {
  /** Open with a freshly built card; `null` closes any open dialog. */
  render(build: ModalShellBuild | null): void;
  /** Tear down the host subtree WITHOUT restoring focus (unmount/relocation, UI §2.2.1). */
  dispose(): void;
}

let modalSeq = 0;

export function createModalShell(host: HTMLElement, idPrefix: string): ModalShell {
  const doc = host.ownerDocument;
  const titleId = `${idPrefix}-${modalSeq++}`;
  let opener: HTMLElement | null = null;
  const close = (): void => {
    host.replaceChildren();
    opener?.focus();
    opener = null;
  };
  return {
    render(build) {
      if (!build) return close();
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
      modal.tabIndex = -1;
      modal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') return close();
        if (e.key === 'Tab') {
          const f = [
            ...modal.querySelectorAll<HTMLElement>('a[href],button,input,textarea,select,[tabindex]'),
          ].filter((el) => !el.hasAttribute('disabled') && el.getAttribute('tabindex') !== '-1');
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

      const { card, initialFocus, describedById } = build({ doc, titleId, close });
      if (describedById) modal.setAttribute('aria-describedby', describedById);
      modal.append(card);
      host.append(scrim, modal);
      (initialFocus ?? modal).focus();
    },
    dispose() {
      host.replaceChildren();
      opener = null;
    },
  };
}
