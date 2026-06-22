// Awaiting-human attention cue (§24.2.3 T4) — a relocatable organism (UI-STANDARDS §1.3) rendering
// design/shell/loop-flow.html's `.attn-bar`. MUST be mounted in the always-visible main region: a
// hidden strip must never be able to suppress it. Dismiss only hides — it is not a gate action and
// must never inject or change loop state.
//
// Host stays a live region: never toggle [hidden]/display:none. Emptying it (CSS `.attn-bar:empty`
// collapses it) is what makes the next inject announce (WAI-ARIA Alert pattern, WCAG 4.1.3); an empty
// host has no focusables, so there is no hidden-but-focusable trap (§22.2).

import type { FlowLoopView } from '../../shared/ipc';
import { sameOccurrence, type Occurrence } from '../../shared/occurrence';

export interface AttentionCueDeps {
  /** Called after a dismiss removed the focused control, so the root can place focus (WCAG 2.4.3); the
   *  cue owns only its subtree and signals across the contract rather than reaching across organisms. */
  onDismiss?: () => void;
}

export interface AttentionCue {
  /** Repaint from the loop mirror; `null` / non-human-needed clears it. */
  render(loop: FlowLoopView | null, repoKey: string | null): void;
  /** Clean teardown (UI-STANDARDS). */
  dispose(): void;
}

export function createAttentionCue(host: HTMLElement, deps: AttentionCueDeps = {}): AttentionCue {
  const doc = host.ownerDocument; // host's document, not global — relocation (UI §2.2.1)
  host.setAttribute('role', 'alert'); // WCAG 4.1.3: assertive so the alert reaches AT immediately
  host.setAttribute('aria-live', 'assertive');

  // Per repo (§16.3): a detour to another repo must not clear a repo's dismissal.
  const dismissed = new Map<string | null, Occurrence>();
  let shown: Occurrence | null = null;

  // The terminal's FitAddon refits on this resize (§7.1): the cue changed the layout without a window resize.
  const signalLayout = (): void => {
    doc.defaultView?.dispatchEvent(new Event('resize'));
  };

  const hide = (): void => {
    if (shown === null) return;
    shown = null;
    host.replaceChildren();
    signalLayout();
  };

  const show = (loop: FlowLoopView, occ: Occurrence): void => {
    if (sameOccurrence(shown, occ)) return;
    const wasHidden = shown === null;
    shown = occ;

    const dot = doc.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');

    const msg = doc.createElement('span');
    msg.className = 'msg';
    msg.dataset.attnMsg = '';
    const lead = doc.createElement('b');
    lead.textContent = 'Loop needs you';
    const detail = doc.createElement('span');
    detail.className = 'it';
    const pr = loop.pr !== null ? ` · PR #${loop.pr}` : '';
    detail.textContent = `${loop.status} · iter ${loop.iteration}${pr}`;
    msg.append(lead, doc.createTextNode(' — '), detail);

    const dismiss = doc.createElement('button');
    dismiss.className = 'iconbtn x';
    dismiss.dataset.attnDismiss = '';
    dismiss.title = 'Dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss attention cue');
    dismiss.textContent = '✕';
    dismiss.addEventListener('click', () => {
      const hadFocus = host.contains(doc.activeElement);
      dismissed.set(occ.repoKey, occ);
      hide();
      if (hadFocus) deps.onDismiss?.();
    });

    host.replaceChildren(dot, msg, dismiss);
    if (wasHidden) signalLayout();
  };

  return {
    render(loop, repoKey) {
      if (!loop || loop.humanNeeded !== true) {
        hide();
        return;
      }
      const occ: Occurrence = { repoKey, status: loop.status, iteration: loop.iteration };
      if (sameOccurrence(dismissed.get(repoKey) ?? null, occ)) {
        hide();
        return;
      }
      show(loop, occ);
    },
    dispose() {
      host.replaceChildren();
    },
  };
}
