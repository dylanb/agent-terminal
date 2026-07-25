export interface ModalCard {
  card: HTMLElement;
  initialFocus: HTMLElement | null;
  describedById?: string;
  /** The card's body slots (UI §5.7), when its content can outgrow the card's max-height. `grow` is the
   *  chain that absorbs the card's leftover column height; `scroll` is the one box within it that scrolls.
   *  Naming them on the contract — rather than leaving the shell's stylesheet to reach for an organism's
   *  own class names — is what keeps the shell from knowing anything about its callers. */
  grow?: HTMLElement;
  scroll?: HTMLElement;
}

export type ModalShellBuild = (ctx: {
  doc: Document;
  titleId: string;
  /** Dismiss: the user declined (Escape / scrim / a Cancel button). Fires `onDismiss`. */
  close: () => void;
  /** Accept: the user's own affirmative action (Confirm / Install). Closes WITHOUT firing `onDismiss`, so a
   *  caller that retracts the operation on dismissal does not also retract the one it is about to run. */
  confirm: () => void;
}) => ModalCard;

export interface ModalShell {
  /** Open with a freshly built card; `null` closes any open dialog. */
  render(build: ModalShellBuild | null, restoreFocusTo?: HTMLElement | null): void;
  /** Tear down the host subtree WITHOUT restoring focus (unmount/relocation, UI §2.2.1). */
  dispose(): void;
}

export interface ModalShellOptions {
  /** WAI-ARIA APG: `alertdialog` for a dialog raised by the system to interrupt the user with an urgent
   *  message; `dialog` (the default) when the user asked for it. */
  role?: 'dialog' | 'alertdialog';
  /** Called when the element that opened the dialog is gone by the time it closes, so focus has nowhere to
   *  return (WCAG SC 2.4.3). The caller owns the fallback landing spot; without one focus falls to <body>. */
  onFocusLost?: () => void;
}

let modalSeq = 0;

export function createModalShell(
  host: HTMLElement,
  idPrefix: string,
  /** The user DISMISSED the dialog — Escape, the scrim, or the build's Cancel. NOT fired for the build's
   *  `confirm` (an accept is not a dismissal), nor for any caller-driven teardown that replaces or clears the
   *  card — `render(build)` over an open one, `render(null)`, `dispose`. A displaced dialog's own
   *  cancellation is the displacing caller's concern (confirmDialog's `pending`), not this signal's. */
  onDismiss?: () => void,
  opts?: ModalShellOptions,
): ModalShell {
  const doc = host.ownerDocument;
  const titleId = `${idPrefix}-${modalSeq++}`;
  let opener: HTMLElement | null = null;
  const clear = (): void => {
    host.replaceChildren();
    // A surface behind the dialog may have re-rendered and detached the opener; focusing a detached node
    // silently does nothing and strands the keyboard user at the top of the document.
    if (opener?.isConnected) opener.focus();
    else if (opener) opts?.onFocusLost?.();
    opener = null;
  };
  const close = (): void => {
    const wasOpen = host.firstChild !== null;
    clear();
    if (wasOpen) onDismiss?.();
  };
  return {
    render(build, restoreFocusTo) {
      if (!build) return clear();
      const wasOpen = host.firstChild !== null;
      host.replaceChildren();
      if (!wasOpen) {
        opener =
          restoreFocusTo === undefined
            ? doc.activeElement as HTMLElement | null
            : restoreFocusTo;
      }

      const scrim = doc.createElement('div');
      scrim.className = 'flow-scrim';
      scrim.addEventListener('click', close);

      const modal = doc.createElement('div');
      modal.className = 'flow-modal';
      modal.setAttribute('role', opts?.role ?? 'dialog');
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

      const { card, initialFocus, describedById, grow, scroll } = build({ doc, titleId, close, confirm: clear });
      if (describedById) modal.setAttribute('aria-describedby', describedById);
      grow?.setAttribute('data-modal-grow', '');
      scroll?.setAttribute('data-modal-scroll', '');
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
