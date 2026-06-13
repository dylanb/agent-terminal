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
