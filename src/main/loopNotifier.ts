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
  /** Observe a flow view and raise / dedup / clear the OS notification accordingly. */
  observe(view: FlowStateView): void;
}

export function createLoopNotifier(deps: LoopNotifierDeps): LoopNotifier {
  // The single carried distinct-entry identity (§24.2.3 T4): the last human-needed (status,iteration)
  // signalled. Held across non-human-needed views so a repeat of an already-signalled occurrence stays
  // deduped; a different (status,iteration) is a distinct entry. Null until the first entry, so the
  // initial human-needed view at app start / flow-open is by definition distinct.
  let lastSignalled: { status: string; iteration: number } | null = null;
  let closeActive: (() => void) | null = null;

  const clearActive = (): void => {
    closeActive?.();
    closeActive = null;
  };

  return {
    observe(view) {
      const loop = view.loop;
      if (!loop || loop.humanNeeded !== true) {
        clearActive(); // null / non-human mirror: dismiss any showing notification (the carried id stays)
        return;
      }
      if (lastSignalled !== null && lastSignalled.status === loop.status && lastSignalled.iteration === loop.iteration) {
        return; // a repeat of the already-signalled occurrence — no re-raise
      }
      lastSignalled = { status: loop.status, iteration: loop.iteration };
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
    },
  };
}
