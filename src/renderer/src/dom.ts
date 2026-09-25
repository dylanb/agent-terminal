// Typed required-element contract for the renderer's static DOM (§9.1): the pane's element ids are a
// real interface between index.html, the CSS, and the wiring code. Failing loud and naming the id
// beats `getElementById(id)!` assertions that defer the failure to a later null-deref.

/** Capture whether `el` holds focus now and return a restorer for after an async action that may
 *  disable `el`. The restorer returns focus to `el` only if `el` had focus at capture AND focus has
 *  not since moved away — it is still on `el`, or was blurred to `<body>` by the disable — so it never
 *  steals focus the user redirected mid-action (WCAG 2.4.3). */
export function captureFocusReturn(el: HTMLElement): () => void {
  const doc = el.ownerDocument;
  const hadFocus = doc.activeElement === el;
  return () => {
    if (hadFocus && (doc.activeElement === doc.body || doc.activeElement === el)) el.focus();
  };
}

/** WCAG 2.4.3. A popup is recognised only by these ARIA attributes — its listbox, its expanded
 *  `aria-haspopup="listbox"` trigger, or a control sharing that trigger's parent: one outside them has its
 *  Escape taken by the shell, which closes the loop panel or exits full screen behind the still-open popup. */
export function focusedPopupOwnsEscape(doc: Document): boolean {
  const el = doc.activeElement;
  if (!el) return false;
  if (el.closest('[role="listbox"], [aria-haspopup="listbox"][aria-expanded="true"]') != null) return true;
  return el.parentElement?.querySelector(':scope > [aria-haspopup="listbox"][aria-expanded="true"]') != null;
}

/** Capture whether focus is inside `container`, and return a restorer to run after its subtree is
 *  rebuilt: it focuses the element `resolve()` yields (resolved at restore time, so it may be freshly
 *  built) only if focus was inside at capture and has not since moved away (WCAG 2.4.3). */
export function captureSubtreeFocus(container: HTMLElement): (resolve: () => HTMLElement | null | undefined) => void {
  const doc = container.ownerDocument;
  const had = container.contains(doc.activeElement);
  return (resolve) => {
    if (had && (doc.activeElement === doc.body || container.contains(doc.activeElement))) resolve()?.focus();
  };
}

/** Look up a required element by id; throw naming the id if it is absent. */
export function requireElement<T extends HTMLElement = HTMLElement>(id: string, doc: Document = document): T {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`required element #${id} not found`);
  return el as T;
}

/** Resolve a record of {handle: id} into a record of typed element handles. */
export function resolveElements<K extends string>(
  ids: Record<K, string>,
  doc: Document = document,
): Record<K, HTMLElement> {
  const out = {} as Record<K, HTMLElement>;
  for (const key of Object.keys(ids) as K[]) out[key] = requireElement(ids[key], doc);
  return out;
}

/** The action window's element ids (§16.1) — the single declaration of the pane DOM contract. */
export const MONITOR_ELEMENT_IDS = {
  status: 'monitor-status',
  captureLast: 'capture-last',
  blocks: 'monitor-blocks',
  tabCapture: 'tab-capture',
  tabTodo: 'tab-todo',
  panelCapture: 'panel-capture',
  panelTodo: 'panel-todo',
  unreadDot: 'capture-unread',
  todoCount: 'todo-count',
  todoList: 'todo-list',
} as const;

export type MonitorElements = Record<keyof typeof MONITOR_ELEMENT_IDS, HTMLElement>;

export function resolveMonitorElements(doc: Document = document): MonitorElements {
  return resolveElements(MONITOR_ELEMENT_IDS, doc);
}
