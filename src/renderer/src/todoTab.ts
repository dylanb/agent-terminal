// Todo tab (§24.1 mockup-exact / §16.3 / §16.4 / §24.2.1): a flat, repo-scoped todo list. Owns the
// todo state; the Capture tab reaches it only through the narrow TodoSink surface, so the two tabs
// share state through one owner, not a scope.
//
// The §24.2.1 restorations: manual add (§16.4), reorder (§16.4: ↑/↓ for keyboard + HTML5 drag),
// edit-in-place (§16.3: contenteditable, not a textarea swap; a mid-edit repo swap defers), and a
// two-step undoable delete (§16.4).

import type { MonitorApi, TodoItem, TodoSource, TodoTemplateRef } from '../../shared/ipc';
import { TODO_UNDO_MS, type DoInject } from './paneActions';
import { createPressGroup, onPress, type PressAction } from './pressable';

/** The slice the Capture tab needs to push a capture into the list and undo it (§16.2). */
export interface TodoSink {
  currentRepoKey(): string | null;
  /** Add from a capture action; returns the new item (for Undo) or null. Refreshes count + list. */
  addFromCapture(text: string, source: TodoSource): Promise<TodoItem | null>;
  /** Undo a capture-driven add (§16.2): delete the item that was just added. */
  deleteTodo(repoKey: string, id: string): Promise<void>;
}

export interface TodoTab extends TodoSink {
  /** A repo-key change (§16.3): swap the displayed list, or defer if an edit is open. */
  onRepoChanged(repoKey: string): void;
  /** Re-pull the current repo's list (tab activation, external change signal). */
  refresh(): void;
}

export interface TodoTabDeps {
  todoListEl: HTMLElement;
  todoCountEl: HTMLElement;
  monitor: Pick<
    MonitorApi,
    | 'todoList'
    | 'todoAdd'
    | 'todoUpdate'
    | 'todoReorder'
    | 'todoSetStatus'
    | 'todoDelete'
    | 'listTemplates'
    | 'instantiateTemplate'
  >;
  /** Inject seam (§16.2 Send) — injected so the tab never reaches the window.monitor global. */
  doInject: DoInject;
}

/** Provenance line for a todo: where it came from, in the mockup's `.src` voice. */
function provenanceText(source: TodoSource | undefined): string {
  if (!source || source.type === 'manual') return 'manual';
  return `from ${source.type}`;
}

let todoSeq = 0; // instance-unique picker ids: two todoTab instances in one document must not collide (UI §2.2 rule 1)

export function createTodoTab(deps: TodoTabDeps): TodoTab {
  const { todoListEl, todoCountEl, monitor, doInject } = deps;
  // Build all DOM from the host's document, never the ambient global — keeps the pane
  // relocatable to a separate-process window (UI-STANDARDS §3.3).
  const doc = todoListEl.ownerDocument;
  const pickerId = `todo-tmpl-picker-${todoSeq++}`; // toggle's aria-controls target
  let currentRepoKey: string | null = null;
  let todos: TodoItem[] = [];
  // A repo swap defers while an edit is open so the in-flight edit writes to its own repo (§16.3).
  let editingId: string | null = null;
  let pendingRepoKey: string | null = null;
  // The delete is deferred for TODO_UNDO_MS so Undo needs no re-add (§16.4). Both vars are render
  // state (survive a re-render).
  let confirmingDeleteId: string | null = null;
  const pendingDelete = new Map<string, ReturnType<typeof setTimeout>>();
  // On-demand template picker (§4.1/§6): main gates the library to the active step (empty when none).
  // Render state, so the open disclosure survives a re-render (it stays open across an add).
  let templates: TodoTemplateRef[] = [];
  let templateDefault: string | undefined;
  let templateSelected: string | undefined;
  let templateOpen = false;
  // Refocus the contextually-correct control after a re-render destroyed the one the user just
  // activated, so a keyboard user is never dropped to <body> (WCAG 2.4.3). Consumed once per render.
  let focusAfterRender: (() => void) | null = null;
  // Every list change answers with the whole list, so two in flight would race to replace it.
  const listChanges = createPressGroup();

  function updateTodoCount(): void {
    todoCountEl.textContent = String(todos.filter((t) => t.status !== 'done').length);
  }

  /** Outstanding = not done (active or in_progress): the reorderable top run that carries the
   *  row-action cluster; only `done` rows drop out (§16.3 tri-state). */
  const isOutstanding = (t: TodoItem): boolean => t.status !== 'done';

  function setTodos(list: TodoItem[]): void {
    todos = list;
    updateTodoCount();
    renderTodos();
  }

  function refresh(): void {
    if (!currentRepoKey) return;
    // A rejected invoke (main restart) keeps the current UI, never an unhandled rejection.
    void monitor.todoList(currentRepoKey).then(setTodos).catch(() => {});
    // Re-pull the template library: main gates it to the active step, and the flow strip fires
    // FLOW_CHANGED (which refreshes us) as the step advances (§4.1).
    void monitor
      .listTemplates(currentRepoKey)
      .then((lib) => {
        templates = lib.templates;
        templateDefault = lib.defaultRef;
        renderTodos();
      })
      .catch(() => {});
  }

  function applyRepoSwap(repoKey: string): void {
    currentRepoKey = repoKey;
    refresh();
  }

  function onRepoChanged(repoKey: string): void {
    if (editingId !== null) {
      pendingRepoKey = repoKey;
      renderTodos(); // surface the blocked-swap notice
      return;
    }
    applyRepoSwap(repoKey);
  }

  function resolveEdit(): void {
    editingId = null;
    if (pendingRepoKey !== null) {
      const next = pendingRepoKey;
      pendingRepoKey = null;
      applyRepoSwap(next);
    } else {
      renderTodos();
    }
  }

  function labelledButton(cls: string, label: string, ariaLabel: string): HTMLButtonElement {
    const b = doc.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.setAttribute('aria-label', ariaLabel);
    return b;
  }

  function actionButton(cls: string, label: string, ariaLabel: string, onClick: PressAction): HTMLButtonElement {
    const b = labelledButton(cls, label, ariaLabel);
    onPress(b, onClick);
    return b;
  }

  function listChangeButton(cls: string, label: string, ariaLabel: string, todoId: string, change: PressAction): { button: HTMLButtonElement; press: () => void } {
    const button = labelledButton(cls, label, ariaLabel);
    return { button, press: listChanges.bind(button, change, { key: `${cls}:${todoId}` }) };
  }

  const activeOf = (ordered: TodoItem[]): TodoItem[] => ordered.filter(isOutstanding);

  /** Persist a new ACTIVE ordering while leaving every done row in its display slot — the
   *  active ids are slotted back into the positions actives occupied in the full order, so a
   *  reorder never shoves an inline done row (§16.4). */
  function commitActiveOrder(ordered: TodoItem[], newActive: TodoItem[]): Promise<void> | undefined {
    if (!currentRepoKey) return undefined;
    let k = 0;
    const ids = ordered.map((t) => (isOutstanding(t) ? newActive[k++].id : t.id));
    // A rejected invoke (main restart) keeps the current order, never an unhandled rejection.
    return monitor.todoReorder(currentRepoKey, ids).then(setTodos).catch(() => {});
  }

  /** Move an active item one slot up/down within the active run (skipping done rows). */
  function moveActive(ordered: TodoItem[], item: TodoItem, dir: -1 | 1): Promise<void> | undefined {
    const active = activeOf(ordered);
    const i = active.findIndex((t) => t.id === item.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= active.length) return undefined;
    [active[i], active[j]] = [active[j], active[i]];
    return commitActiveOrder(ordered, active);
  }

  /** Re-render and move focus to the row's control matching `sel` (a11y, §WCAG 2.4.3). */
  function rerenderFocusing(id: string, sel: string): void {
    focusAfterRender = () => rowEl(id)?.querySelector<HTMLElement>(sel)?.focus();
    renderTodos();
  }

  function renderActions(t: TodoItem, ordered: TodoItem[]): { actions: HTMLElement; save: (() => void) | null } {
    const actions = doc.createElement('div');
    actions.className = 'todo-actions';

    if (t.id === editingId) {
      const save = listChangeButton('todo-save pill sm signal', 'Save', 'Save todo', t.id, () => commitEdit(t));
      actions.append(
        save.button,
        actionButton('todo-cancel linkbtn', 'Cancel', 'Cancel edit', () =>
          rerenderFocusingAfterResolve(t.id, () => resolveEdit()),
        ),
      );
      return { actions, save: save.press };
    }

    // The cluster is rendered for every row and only DISABLED when done, so completing a todo never
    // changes the row's width (operator decision); Delete stays usable on done rows.
    const outstanding = isOutstanding(t);
    const active = activeOf(ordered);
    const ai = active.findIndex((x) => x.id === t.id);
    const up = listChangeButton('todo-up iconbtn', '↑', 'Move up', t.id, () => moveActive(ordered, t, -1)).button;
    up.disabled = !outstanding || ai <= 0;
    const down = listChangeButton('todo-down iconbtn', '↓', 'Move down', t.id, () => moveActive(ordered, t, 1)).button;
    down.disabled = !outstanding || ai === active.length - 1;
    const edit = actionButton('todo-edit iconbtn', '✎', 'Edit todo', () => {
      editingId = t.id;
      rerenderFocusing(t.id, '.tx');
    });
    edit.disabled = !outstanding;
    // Send pastes into the agent's input WITHOUT submitting (§9.3 submit:false / §16.2 Insert) and
    // marks the todo in_progress — the sole entry into that state (§16.3).
    const send = listChangeButton('todo-send pill sm signal', 'Send', 'Send todo to agent', t.id, () => {
      doInject(t.text, false);
      if (t.status !== 'in_progress') return monitor.todoSetStatus(t.repoKey, t.id, 'in_progress').then(setTodos).catch(() => {});
      return undefined;
    }).button;
    send.disabled = !outstanding;
    const del = actionButton('todo-delete iconbtn', '×', 'Delete todo', () => {
      confirmingDeleteId = t.id;
      rerenderFocusing(t.id, '.todo-delete-confirm');
    });
    actions.append(up, down, edit, send, del);
    return { actions, save: null };
  }

  /** Two-step delete confirmation, stacked BELOW the action cluster so showing it never changes the
   *  cluster's width — the row just grows a line (§16.4, operator decision). */
  function renderDeleteBar(t: TodoItem): HTMLElement {
    const bar = doc.createElement('div');
    bar.className = 'todo-delete-bar';
    bar.append(
      actionButton('todo-delete-confirm pill sm', 'Confirm delete?', 'Confirm delete', () => beginPendingDelete(t)),
      actionButton('todo-delete-cancel linkbtn', 'Cancel', 'Cancel delete', () => {
        confirmingDeleteId = null;
        rerenderFocusing(t.id, '.todo-delete');
      }),
    );
    return bar;
  }

  /** Run a resolve that re-renders, then focus `.todo-edit` of the row if it still exists. */
  function rerenderFocusingAfterResolve(id: string, resolve: () => void): void {
    focusAfterRender = () => rowEl(id)?.querySelector<HTMLElement>('.todo-edit')?.focus();
    resolve();
  }

  async function commitEdit(t: TodoItem, el?: HTMLElement): Promise<void> {
    const tx = (el ?? rowEl(t.id))?.querySelector<HTMLElement>('.tx');
    const next = (tx?.textContent ?? t.text).trim();
    if (!next) return; // empty-guard (matches manual add): never persist a blank row; stay in edit
    // The edit targets the list's own repo (t.repoKey), not the live cwd (§16.3).
    let updated: TodoItem[];
    try {
      updated = await monitor.todoUpdate(t.repoKey, t.id, next);
    } catch {
      return; // IPC failure (main restart): keep the user in the edit state, list unchanged.
    }
    todos = updated;
    updateTodoCount();
    focusAfterRender = () => rowEl(t.id)?.querySelector<HTMLElement>('.todo-edit')?.focus();
    resolveEdit();
  }

  function rowEl(id: string): HTMLElement | null {
    return todoListEl.querySelector<HTMLElement>(`.todo[data-todo-id="${id}"]`);
  }

  function renderPendingDelete(t: TodoItem): HTMLElement {
    const row = doc.createElement('div');
    row.className = 'todo pending-delete';
    row.dataset.todoId = t.id;
    const note = doc.createElement('span');
    note.className = 'deleted-note';
    note.textContent = 'Deleted';
    const undo = actionButton('todo-undo linkbtn', 'Undo', 'Undo delete', () => cancelPendingDelete(t.id));
    row.append(note, undo);
    return row;
  }

  function beginPendingDelete(t: TodoItem): void {
    confirmingDeleteId = null;
    // The delete targets the item's own repo (t.repoKey), not the live cwd, so a mid-window swap
    // still deletes from the right list (§16.3).
    pendingDelete.set(
      t.id,
      setTimeout(() => {
        pendingDelete.delete(t.id);
        // A rejected invoke (main restart) keeps the current list, never an unhandled rejection.
        void monitor.todoDelete(t.repoKey, t.id).then(setTodos).catch(() => {});
      }, TODO_UNDO_MS),
    );
    rerenderFocusing(t.id, '.todo-undo');
  }

  function cancelPendingDelete(id: string): void {
    const timer = pendingDelete.get(id);
    if (timer) clearTimeout(timer);
    pendingDelete.delete(id);
    renderTodos(); // restored from `todos` — the server delete never ran
  }

  function renderTodoRow(t: TodoItem, ordered: TodoItem[]): HTMLElement {
    if (pendingDelete.has(t.id)) return renderPendingDelete(t);

    const done = t.status === 'done';
    const row = doc.createElement('div');
    row.className = `todo${done ? ' done' : ''}${t.status === 'in_progress' ? ' in-progress' : ''}`;
    row.dataset.todoId = t.id;
    row.draggable = isOutstanding(t) && editingId === null;

    const chk = doc.createElement('button');
    chk.className = 'chk';
    chk.setAttribute('role', 'checkbox');
    // Tri-state checkbox (§16.3).
    chk.setAttribute('aria-checked', done ? 'true' : t.status === 'in_progress' ? 'mixed' : 'false');
    chk.setAttribute('aria-label', done ? 'Mark todo active' : 'Mark todo done');
    listChanges.bind(chk, async () => {
      try {
        setTodos(await monitor.todoSetStatus(t.repoKey, t.id, done ? 'active' : 'done'));
      } catch {
        // IPC failure (main restart): leave the UI unchanged, never an unhandled rejection.
      }
    }, { key: `status:${t.id}` });
    const { actions, save } = renderActions(t, ordered);

    const body = doc.createElement('div');
    body.className = 'body';
    const tx = doc.createElement('div');
    tx.className = 'tx';
    tx.textContent = t.text;
    if (t.id === editingId) {
      tx.contentEditable = 'true';
      tx.tabIndex = 0; // focusable so enter-edit can move focus here (a11y)
      tx.classList.add('editing');
      // Name the in-place editor for AT — the ✎ that named the action is gone in edit mode.
      tx.setAttribute('role', 'textbox');
      tx.setAttribute('aria-label', 'Edit todo text');
      tx.setAttribute('aria-multiline', 'true');
      tx.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          save?.();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          // Escape-cancel restores focus to the row's edit button, not <body> (WCAG 2.4.3, §16.4).
          rerenderFocusingAfterResolve(t.id, () => resolveEdit());
        }
      });
    }
    const src = doc.createElement('div');
    src.className = 'src';
    src.textContent = provenanceText(t.source);
    body.append(tx, src);

    row.append(chk, body, actions);
    if (t.id === confirmingDeleteId && t.id !== editingId) row.append(renderDeleteBar(t));
    return row;
  }

  // The relocated template control (§4.1/§9.1): a collapsed disclosure, so the resting composer is
  // just the manual-add field. Rendered only when main offered templates (it gates them to an active
  // step), so the toggle's mere presence means "a step is active and has templates."
  function renderTemplatePicker(): void {
    if (templates.length === 0) return;

    const wrap = doc.createElement('div');
    wrap.className = `todo-tmpl${templateOpen ? ' open' : ''}`;

    const toggle = doc.createElement('button');
    toggle.className = 'tmpl-toggle linkbtn';
    toggle.setAttribute('aria-expanded', String(templateOpen));
    toggle.setAttribute('aria-controls', pickerId);
    toggle.setAttribute('aria-label', 'Add todos from a template');
    const car = doc.createElement('span');
    car.className = 'car';
    car.setAttribute('aria-hidden', 'true');
    car.textContent = '▾';
    toggle.append(doc.createTextNode('From template '), car);
    onPress(toggle, () => {
      templateOpen = !templateOpen;
      focusAfterRender = () =>
        todoListEl.querySelector<HTMLElement>(templateOpen ? '.tmpl-pick' : '.tmpl-toggle')?.focus();
      renderTodos();
    });
    wrap.append(toggle);

    if (templateOpen) {
      const group = doc.createElement('div');
      group.className = 'tmpl-picker';
      group.id = pickerId;
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Instantiate a todo template');
      // Escape collapses the picker and returns focus to the toggle (keyboard, WCAG 2.1.2).
      group.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        templateOpen = false;
        focusAfterRender = () => todoListEl.querySelector<HTMLElement>('.tmpl-toggle')?.focus();
        renderTodos();
      });

      const select = doc.createElement('select');
      select.className = 'tmpl-pick';
      select.setAttribute('aria-label', 'Todo template');
      for (const t of templates) {
        const opt = doc.createElement('option');
        opt.value = t.ref;
        opt.textContent = t.name;
        select.append(opt);
      }
      const sel = templateSelected ?? templateDefault;
      if (sel && templates.some((t) => t.ref === sel)) select.value = sel;
      select.addEventListener('change', () => (templateSelected = select.value));

      const add = doc.createElement('button');
      add.className = 'tmpl-add pill sm signal';
      add.textContent = 'Add todos';
      listChanges.bind(add, () => {
        if (!currentRepoKey) return undefined;
        // Main silently skips already-present items. The picker stays open (operator decision). A
        // rejected invoke (main restart) leaves the list unchanged.
        return monitor
          .instantiateTemplate(currentRepoKey, select.value)
          .then(setTodos)
          .catch(() => {});
      });

      group.append(select, add);
      wrap.append(group);
    }

    todoListEl.appendChild(wrap);
  }

  function renderTodos(): void {
    todoListEl.replaceChildren();

    if (pendingRepoKey !== null) {
      const notice = doc.createElement('div');
      notice.className = 'swap-blocked';
      notice.textContent = 'Directory changed — save or cancel this edit to switch todo lists.';
      todoListEl.appendChild(notice);
    }

    const addRow = doc.createElement('div');
    addRow.className = 'todo-add';
    const input = doc.createElement('textarea');
    input.id = 'todo-new';
    input.className = 'todo-new';
    input.rows = 1;
    input.setAttribute('aria-label', 'New todo');
    input.placeholder = 'Add a todo…';
    const addBtn = doc.createElement('button');
    addBtn.id = 'todo-add-btn';
    addBtn.className = 'pill sm signal';
    addBtn.textContent = 'Add';
    const submitAdd = async (): Promise<void> => {
      const text = input.value.trim();
      if (!text || !currentRepoKey) return;
      let list: TodoItem[];
      try {
        list = await monitor.todoAdd(currentRepoKey, text, { type: 'manual' });
      } catch {
        return; // IPC failure (main restart): keep the typed text and list unchanged.
      }
      setTodos(list);
      input.value = '';
    };
    const pressAdd = listChanges.bind(addBtn, submitAdd);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        pressAdd();
      }
    });
    addRow.append(input, addBtn);
    todoListEl.appendChild(addRow);

    renderTemplatePicker();

    const list = doc.createElement('div');
    list.className = 'todos';
    // One flat list in stored order; done rows render inline (dimmed), not in a section.
    const ordered = [...todos].sort((a, b) => a.order - b.order);
    ordered.forEach((t) => list.appendChild(renderTodoRow(t, ordered)));
    todoListEl.appendChild(list);

    wireDragReorder(list, ordered);

    const focus = focusAfterRender;
    focusAfterRender = null;
    if (focus) focus();
  }

  // HTML5 drag reorder of the active rows (§16.4); ↑/↓ are the keyboard path. Reorders within the
  // active run only, so dropping near an inline done row never shoves it.
  function wireDragReorder(list: HTMLElement, ordered: TodoItem[]): void {
    let dragId: string | null = null;
    list.addEventListener('dragstart', (e) => {
      dragId = (e.target as HTMLElement).closest<HTMLElement>('.todo')?.dataset.todoId ?? null;
    });
    list.addEventListener('dragover', (e) => e.preventDefault());
    list.addEventListener('drop', (e) => {
      const targetId = (e.target as HTMLElement).closest<HTMLElement>('.todo')?.dataset.todoId;
      if (!dragId || !targetId || dragId === targetId) return;
      const active = activeOf(ordered);
      const from = active.findIndex((t) => t.id === dragId);
      const to = active.findIndex((t) => t.id === targetId);
      if (from < 0 || to < 0) return;
      const [moved] = active.splice(from, 1);
      active.splice(to, 0, moved);
      commitActiveOrder(ordered, active);
    });
  }

  // Render immediately so the add row shows from mount: refresh() is repo-gated, so without this
  // the tab is blank until the first OSC 7.
  renderTodos();

  return {
    onRepoChanged,
    refresh,
    currentRepoKey: () => currentRepoKey,
    async addFromCapture(text, source) {
      if (!currentRepoKey) return null;
      const before = new Set(todos.map((t) => t.id));
      const list = await monitor.todoAdd(currentRepoKey, text, source);
      setTodos(list);
      return list.find((t) => !before.has(t.id)) ?? null;
    },
    async deleteTodo(repoKey, id) {
      setTodos(await monitor.todoDelete(repoKey, id));
    },
  };
}
