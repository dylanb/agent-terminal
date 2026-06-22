// Shared action-window primitives (§16.2) used by both the Capture and Todo tabs. The window-event
// constants below are the decoupled bus (§9.1) that lets the panes signal each other WITHOUT
// importing each other's modules — the coupling no type can catch, so each names the breakage it
// prevents. Kept out of monitor.ts to avoid an import cycle; monitor.ts re-exports them.

export const FOCUS_TERMINAL_EVENT = 'app:focus-terminal';

// Fired when a todo is added from the terminal pane; the action window must re-pull its repo-scoped
// count/list or it goes stale.
export const TODOS_CHANGED_EVENT = 'app:todos-changed';

// Fired by the flow strip after a lifecycle transition so the todo widget re-pulls its template
// picker (main gates it to an in_progress step); the monitor pane never imports the flow subsystem
// (§4.1/§9.1).
export const FLOW_CHANGED_EVENT = 'app:flow-changed';

// The shell announces the now-active view so that view's organism focuses its own primary control;
// the shell never reaches into a sibling to focus it (§22.4). `detail.view` is the ViewId, kept a
// string so this leaf doesn't depend on the shell.
export const FOCUS_VIEW_EVENT = 'app:focus-view';

// Cross-highlight (§16.8). The terminal pane owns the coordinates — it marker-anchors every
// capture's span (xterm markers track reflow) so a resize never stales the link, which is why
// reveals are keyed by capture **id**, not raw rows. Break this and a post-resize reveal lands on
// the wrong rows.
//   • CAPTURE_RANGE_ADD: capture → terminal; detail {id, range}.
//   • CAPTURE_RANGE_REMOVE: capture → terminal; detail {id}.
//   • REVEAL_CAPTURE: terminal → capture; detail {id}.
//   • REVEAL_TERMINAL: capture → terminal; detail {id}.
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

export function dismissButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'dismiss';
  btn.textContent = '×';
  btn.setAttribute('aria-label', label);
  btn.addEventListener('click', onClick);
  return btn;
}
