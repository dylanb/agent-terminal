// OS attention notification decision (§24.2.3 T4). Observes the mirrored loop view and raises an
// OS-level notification ONLY when the window is unfocused on a DISTINCT human-needed entry — a
// `(status, iteration)` occurrence that differs from the one last signalled. The distinct-entry
// identity is the single carried `(status, iteration)`; at app start / flow-open there is no prior
// signalled occurrence, so the first human-needed view is by definition distinct. Activating the
// notification focuses the window and emits the renderer reveal signal. A non-human-needed or null
// mirror closes any showing notification. Injects nothing; the human drives agent-loop by hand.

import type { FlowStateView } from '../shared/ipc';

export interface LoopNotifyOpts {
  title: string;
  body: string;
  /** Run when the user activates (clicks) the notification — focus the window + reveal the read-out. */
  onActivate: () => void;
}

export interface LoopNotifierDeps {
  /** Whether the app window currently has focus — the notification raises only when it does not. */
  isFocused: () => boolean;
  /** Raise the OS notification; returns a closer the notifier calls to dismiss a stale/showing one. */
  notify: (opts: LoopNotifyOpts) => () => void;
  /** Bring the app window to focus (notification activation). */
  focusWindow: () => void;
  /** Emit the renderer reveal signal (notification activation). */
  reveal: () => void;
}

export interface LoopNotifier {
  /** Observe a repo's flow view and raise / dedup / clear the OS notification accordingly. */
  observe(repoKey: string, view: FlowStateView): void;
}

export function createLoopNotifier(deps: LoopNotifierDeps): LoopNotifier {
  // The distinct-entry identity (§24.2.3 T4), keyed per repo because the loop is repo-scoped (§16.3): a
  // map of repoKey → the last human-needed (status, iteration) signalled for THAT repo. Per-repo keying
  // is what lets a same-repo return visit (cd A→B→A) stay deduped — a single global slot would be
  // overwritten by B and treat A's return as fresh. A repo absent from the map has never been signalled,
  // so the initial human-needed view at app start / flow-open is by definition distinct.
  const lastSignalled = new Map<string, { status: string; iteration: number }>();
  let closeActive: (() => void) | null = null;
  let activeRepoKey: string | null = null;

  const clearActive = (): void => {
    closeActive?.();
    closeActive = null;
    activeRepoKey = null;
  };

  return {
    observe(repoKey, view) {
      const loop = view.loop;
      if (!loop || loop.humanNeeded !== true) {
        // null / non-human mirror: dismiss only THIS repo's showing notification — a different repo's
        // still-valid one must survive a glance at a non-loop repo (the carried id stays).
        if (activeRepoKey === repoKey) clearActive();
        return;
      }
      const prev = lastSignalled.get(repoKey);
      if (prev && prev.status === loop.status && prev.iteration === loop.iteration) {
        return; // a repeat of this repo's already-signalled occurrence — no re-raise
      }
      lastSignalled.set(repoKey, { status: loop.status, iteration: loop.iteration });
      clearActive(); // the prior occurrence's notification is now stale
      if (deps.isFocused()) return; // unfocused-only raise — the user is present, the in-app cue suffices
      closeActive = deps.notify({
        title: 'Agent loop needs you',
        body: `${loop.status} · iter ${loop.iteration}`,
        onActivate: () => {
          deps.focusWindow();
          deps.reveal();
        },
      });
      activeRepoKey = repoKey;
    },
  };
}
