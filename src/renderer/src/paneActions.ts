// Shared action-window primitives (§16.2) used by both the Capture and Todo tabs.
// Kept out of monitor.ts so the sub-tabs depend on this leaf module, not on the
// coordinator that imports them (no import cycle). monitor.ts re-exports the
// constants for callers that already import them from there (selection.ts, tests).

// Decoupled focus signal (§16.2): the monitor pane must not import terminal modules,
// so it asks for terminal focus via a window event the terminal pane subscribes to.
export const FOCUS_TERMINAL_EVENT = 'app:focus-terminal';

// Decoupled todo-change signal (§16.2): a todo added from the terminal pane (Capture
// selection) must refresh the action window's repo-scoped count/list. Same window-event
// bus as FOCUS_TERMINAL_EVENT, so neither pane imports the other's internals (§9.1).
export const TODOS_CHANGED_EVENT = 'app:todos-changed';

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

/** §16.2 focus rule: Insert → terminal (user finishes there); Insert & submit → stays. */
export function doInject(text: string, submit: boolean): void {
  window.monitor.inject({ text, submit });
  if (!submit) requestTerminalFocus();
}

export function dismissButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'dismiss';
  btn.textContent = '×';
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', onClick);
  return btn;
}
