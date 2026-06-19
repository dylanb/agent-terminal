// Typed required-element contract for the renderer's static DOM (§9.1). The pane's
// element ids are a real interface between index.html, the CSS, and the wiring code;
// declaring them once — and failing loud, naming the id, when one is absent — beats
// scattering `getElementById(id)!` non-null assertions that defer the failure to a
// later null-deref the compiler can't see.

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
