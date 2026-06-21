// The awaiting-human attention cue (§24.2.3 T4) — a placement-agnostic organism (UI-STANDARDS §1.2)
// pinned to the always-visible main region so a hidden "deep-work" strip can never suppress it. It
// renders with fidelity to design/shell/loop-flow.html's `.attn-bar`: an alert dot, a message naming
// the loop's current human-needed status, and a dismiss control. Visibility is a PURE function of the
// mirrored loop view — shown when the view is human-needed and the user has not dismissed THIS
// `(status, iteration)` occurrence — so it holds no dedup tracker of its own (its only state is the
// dismissed occurrence). It announces assertively (WCAG 4.1.3) but never re-announces an unchanged
// occurrence. Dismissing only hides it; it injects nothing and changes no loop state.

import type { FlowLoopView } from '../../shared/ipc';
import { setShown } from './visibility';

export interface AttentionCueDeps {
  /** Called after a dismiss that removed the focused control, so the composition root can land focus on
   *  a logical target instead of letting it drop to `<body>` (WCAG 2.4.3). The cue owns only its host
   *  subtree, so it signals focus placement across the contract rather than reaching across organisms. */
  onDismiss?: () => void;
}

export interface AttentionCue {
  /** Repaint from `repoKey`'s loop mirror; `null` (no loop / non-human-needed / null mirror) clears it. */
  render(loop: FlowLoopView | null, repoKey: string | null): void;
  /** Remove everything the cue created (UI-STANDARDS clean teardown). */
  dispose(): void;
}

interface Occurrence {
  repoKey: string | null;
  status: string;
  iteration: number;
}
const sameOcc = (a: Occurrence | null, b: Occurrence | null): boolean =>
  a !== null && b !== null && a.repoKey === b.repoKey && a.status === b.status && a.iteration === b.iteration;

export function createAttentionCue(host: HTMLElement, deps: AttentionCueDeps = {}): AttentionCue {
  const doc = host.ownerDocument; // build from the host's document so the cue relocates (UI §2.2.1)
  // Assertive (interrupting) live region (WCAG 4.1.3): the alert must reach AT at once. It is set on
  // the persistent host so the announcement fires when its content is populated, never on a hidden node.
  host.setAttribute('role', 'alert');
  host.setAttribute('aria-live', 'assertive');
  setShown(host, false);

  // The ONLY state is the dismissed occurrence; visibility is otherwise a pure function of the view.
  // `shown` tracks what is currently displayed solely to avoid rebuilding (and thus re-announcing) an
  // unchanged occurrence (WCAG 4.1.3, the §15/§22.2 monitor-status re-announce correction).
  let dismissed: Occurrence | null = null;
  let shown: Occurrence | null = null;

  // Showing/hiding the cue resizes the main viewport (it makes room above the active view), so the
  // width/height-sensitive panes — the terminal's FitAddon (§7.1) — must refit. The shell uses this
  // same decoupled resize signal for its drawer/loop-panel/full-screen layout changes.
  const signalLayout = (): void => {
    doc.defaultView?.dispatchEvent(new Event('resize'));
  };

  const hide = (): void => {
    if (shown === null) return;
    shown = null;
    host.replaceChildren();
    setShown(host, false);
    signalLayout();
  };

  const show = (loop: FlowLoopView, occ: Occurrence): void => {
    if (sameOcc(shown, occ)) return; // already announcing this occurrence — do not rebuild/re-announce
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
    // Dismiss only hides THIS occurrence (§24.2.3 T4 non-goal: it is not a gate decision, injects
    // nothing, changes no loop state). A distinct occurrence no longer matches and re-shows. Removing
    // the focused control would drop focus to <body> (WCAG 2.4.3), so when focus was on the cue we hand
    // it back to the composition root to land on a logical target.
    dismiss.addEventListener('click', () => {
      const hadFocus = host.contains(doc.activeElement);
      dismissed = shown;
      hide();
      if (hadFocus) deps.onDismiss?.();
    });

    if (wasHidden) setShown(host, true); // reveal first so the role=alert mutation fires on a visible region (WCAG 4.1.3)
    host.replaceChildren(dot, msg, dismiss);
    if (wasHidden) signalLayout(); // only a hidden→shown flip changes the layout; an occ swap does not
  };

  return {
    render(loop, repoKey) {
      if (!loop || loop.humanNeeded !== true) {
        hide();
        return;
      }
      const occ: Occurrence = { repoKey, status: loop.status, iteration: loop.iteration };
      if (sameOcc(dismissed, occ)) {
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
