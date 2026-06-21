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

export function createLoopNotifier(_deps: LoopNotifierDeps): LoopNotifier {
  return { observe: () => {} };
}
