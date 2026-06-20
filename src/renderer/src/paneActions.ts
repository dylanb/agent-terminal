// Shared action-window primitives (§16.2) used by both the Capture and Todo tabs.
// This is the shared leaf: the sub-tabs and selection.ts import these constants from
// here, not from the monitor coordinator that imports them, so there is no cycle (§9.1).

// Decoupled focus signal (§16.2): the monitor pane must not import terminal modules,
// so it asks for terminal focus via a window event the terminal pane subscribes to.
export const FOCUS_TERMINAL_EVENT = 'app:focus-terminal';

// Decoupled todo-change signal (§16.2): a todo added from the terminal pane (Capture
// selection) must refresh the action window's repo-scoped count/list. Same window-event
// bus as FOCUS_TERMINAL_EVENT, so neither pane imports the other's internals (§9.1).
export const TODOS_CHANGED_EVENT = 'app:todos-changed';

// Decoupled flow-changed signal (§4.1/§9.1): the flow strip fires this after a lifecycle
// transition so the todo widget re-pulls its on-demand template picker (which main gates to an
// active step) — without the monitor pane importing the flow subsystem. Same window-event bus.
export const FLOW_CHANGED_EVENT = 'app:flow-changed';

// Decoupled view-focus signal (§22.4): the shell announces the now-active view (after it shows
// the pane) so that view's organism can focus its own primary control — the shell never reaches
// into a sibling view to focus it. `detail.view` is the ViewId ('1' | '2' | '3'), kept as a
// string here so this leaf module doesn't depend on the shell. Same window-event bus.
export const FOCUS_VIEW_EVENT = 'app:focus-view';

// Cross-highlight signals (§16.8): the same decoupled window-event bus carries the reveal
// directions between the panes, so neither imports the other (§9.1). The terminal pane owns
// the coordinates — it marker-anchors every capture's span (xterm markers track reflow), so
// a resize never stales the link. Reveals are therefore keyed by capture **id**, not raw rows.
//   • CAPTURE_RANGE_ADD: capture pane → terminal; detail {id, range} — a ranged block/finding
//     rendered; the terminal registers start/end markers so the span follows reflow.
//   • CAPTURE_RANGE_REMOVE: capture pane → terminal; detail {id} — that block was dropped;
//     the terminal disposes its markers.
//   • REVEAL_CAPTURE: terminal → capture pane; detail {id} (the capture whose live span the
//     double-clicked row fell in) → the pane scrolls to and border-highlights that block.
//   • REVEAL_TERMINAL: capture pane → terminal; detail {id} (the double-clicked block) → the
//     terminal reads that capture's live marker rows and highlights them.
export const CAPTURE_RANGE_ADD_EVENT = 'app:capture-range-add';
export const CAPTURE_RANGE_REMOVE_EVENT = 'app:capture-range-remove';
export const REVEAL_CAPTURE_EVENT = 'app:reveal-capture';
export const REVEAL_TERMINAL_EVENT = 'app:reveal-terminal';

// A revealed block/terminal span stays highlighted this long before it clears itself (§16.8).
export const REVEAL_HIGHLIGHT_MS = 10_000;

// Add to todo offers an in-place Undo for this long before the source block is
// dismissed and removed (§16.2); after it elapses the add is committed.
export const TODO_UNDO_MS = 60_000;

export function requestTerminalFocus(): void {
  window.dispatchEvent(new CustomEvent(FOCUS_TERMINAL_EVENT));
}

/** Announce that `view` is now the active view so its organism focuses its primary control (§22.4). */
export function announceViewFocus(view: string): void {
  window.dispatchEvent(new CustomEvent(FOCUS_VIEW_EVENT, { detail: { view } }));
}

/** The inject seam organisms receive via deps (so they don't reach the window.monitor global
 *  directly — keeps them substitutable/relocatable, §9.1). The default impl is `doInject`. */
export type DoInject = (text: string, submit: boolean) => void;

/** §16.2 focus rule: Insert → terminal (user finishes there); Insert & submit → stays. */
export const doInject: DoInject = (text, submit) => {
  window.monitor.inject({ text, submit });
  if (!submit) requestTerminalFocus();
};
