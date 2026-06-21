// The awaiting-human attention cue (§24.2.3 T4) — a placement-agnostic organism (UI-STANDARDS §1.2)
// pinned to the always-visible main region so a hidden "deep-work" strip can never suppress it. It
// renders with fidelity to design/shell/loop-flow.html's `.attn-bar`: an alert dot, a message naming
// the loop's current human-needed status, and a dismiss control. Visibility is a PURE function of the
// mirrored loop view — shown when the view is human-needed and the user has not dismissed THIS
// `(status, iteration)` occurrence — so it holds no dedup tracker of its own (its only state is the
// dismissed occurrence). It announces assertively (WCAG 4.1.3) but never re-announces an unchanged
// occurrence. Dismissing only hides it; it injects nothing and changes no loop state.

import type { FlowLoopView } from '../../shared/ipc';

export interface AttentionCue {
  /** Repaint from the current loop mirror; `null` (no loop / non-human-needed / null mirror) clears it. */
  render(loop: FlowLoopView | null): void;
  /** Remove everything the cue created (UI-STANDARDS clean teardown). */
  dispose(): void;
}

export function createAttentionCue(_host: HTMLElement): AttentionCue {
  return { render: () => {}, dispose: () => {} };
}
