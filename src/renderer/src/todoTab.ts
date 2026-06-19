// Todo tab (§24.1 mockup-exact / §16.3 / §16.4 / §24.2.1): a flat, repo-scoped list of
// todos in the converged mockup's language — a checkbox-circle (.chk) that toggles done,
// a body (.tx text + .src provenance), and a row-action cluster (reorder ↑/↓, edit, Send,
// delete) on the right. Owns the todo state (`todos`, `currentRepoKey`, edit/delete render
// state); the Capture tab reaches it only through the narrow TodoSink surface, so the two
// tabs share state through one owner, not a scope.
//
// The §24.2.1 restorations are re-skinned into this card language, not the old chrome:
//  • Manual add (§16.4): a top add-row → `todoAdd {type:'manual'}`.
//  • Reorder (§16.4): ↑/↓ buttons (keyboard/a11y path) + HTML5 drag → `todoReorder`. The
//    full display order is sent so the flat list (done rows inline) stays stable.
//  • Edit-in-place (§16.3): the better affordance — the `.tx` becomes contenteditable in
//    place (no textarea-box swap) with Save/Cancel; a mid-edit repo swap is deferred.
//  • Delete (§16.4): two-step + undoable — × → Confirm/Cancel → a deferred `todoDelete`
//    behind a Deleted/Undo row for TODO_UNDO_MS, capturing the item's own repoKey.

import type { MonitorApi, TodoItem, TodoSource, TodoTemplateRef } from '../../shared/ipc';
import { TODO_UNDO_MS, type DoInject } from './paneActions';

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

export function createTodoTab(deps: TodoTabDeps): TodoTab {
  const { todoListEl, todoCountEl, monitor, doInject } = deps;
  let currentRepoKey: string | null = null;
  let todos: TodoItem[] = [];
  // A repo swap is blocked while a todo edit is open (§16.3); the pending key is applied
  // once the edit resolves so the in-flight edit writes to its own repo.
  let editingId: string | null = null;
  let pendingRepoKey: string | null = null;
  // Delete is a two-step, undoable action (§16.4): × → confirm; confirming hides the row
  // behind an Undo for TODO_UNDO_MS and only then calls todoDelete. Both are render state
  // (survive a re-render); the actual delete is deferred so Undo needs no re-add.
  let confirmingDeleteId: string | null = null;
  const pendingDelete = new Map<string, ReturnType<typeof setTimeout>>();
  // On-demand template picker (§4.1/§6): the library main offers for the active step (empty when
  // none — main gates it), its bound default, the user's live selection, and whether the
  // disclosure is open. Render state, so it survives re-renders (the picker stays open across an add).
  let templates: TodoTemplateRef[] = [];
  let templateDefault: string | undefined;
  let templateSelected: string | undefined;
  let templateOpen = false;
  // Focus is moved to the contextually-correct control after a re-render that destroys the
  // control the user just activated (edit/delete/confirm), so a keyboard user is never dropped
  // to <body> (WCAG 2.4.3). Consumed once per render.
  let focusAfterRender: (() => void) | null = null;

  function updateTodoCount(): void {
    todoCountEl.textContent = String(todos.filter((t) => t.status === 'active').length);
  }

  function setTodos(list: TodoItem[]): void {
    todos = list;
    updateTodoCount();
    renderTodos();
  }

  function refresh(): void {
    if (!currentRepoKey) return;
    void monitor.todoList(currentRepoKey).then(setTodos);
    // Re-pull the template library too: main gates it to the active step, so it appears/disappears
    // as the flow advances (the strip fires FLOW_CHANGED, which refreshes us — §4.1).
    void monitor.listTemplates(currentRepoKey).then((lib) => {
      templates = lib.templates;
      templateDefault = lib.defaultRef;
      renderTodos();
    });
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

  // After Save/Cancel: drop edit state and apply any swap that was blocked.
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

  function actionButton(cls: string, label: string, ariaLabel: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.setAttribute('aria-label', ariaLabel);
    b.addEventListener('click', onClick);
    return b;
  }

  const activeOf = (ordered: TodoItem[]): TodoItem[] => ordered.filter((t) => t.status === 'active');

  /** Persist a new ACTIVE ordering while leaving every done row in its display slot — the
   *  active ids are slotted back into the positions actives occupied in the full order, so a
   *  reorder never shoves an inline done row (§16.4). */
  function commitActiveOrder(ordered: TodoItem[], newActive: TodoItem[]): void {
    if (!currentRepoKey) return;
    let k = 0;
    const ids = ordered.map((t) => (t.status === 'active' ? newActive[k++].id : t.id));
    // On a rejected invoke (main restart) keep the current order; never an unhandled rejection.
    void monitor.todoReorder(currentRepoKey, ids).then(setTodos).catch(() => {});
  }

  /** Move an active item one slot up/down within the active run (skipping done rows). */
  function moveActive(ordered: TodoItem[], item: TodoItem, dir: -1 | 1): void {
    const active = activeOf(ordered);
    const i = active.findIndex((t) => t.id === item.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= active.length) return;
    [active[i], active[j]] = [active[j], active[i]];
    commitActiveOrder(ordered, active);
  }

  /** Re-render and move focus to the row's control matching `sel` (a11y, §WCAG 2.4.3). */
  function rerenderFocusing(id: string, sel: string): void {
    focusAfterRender = () => rowEl(id)?.querySelector<HTMLElement>(sel)?.focus();
    renderTodos();
  }

  function renderActions(t: TodoItem, ordered: TodoItem[]): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'todo-actions';

    // Editing: the `.tx` is contenteditable in place; the cluster is Save/Cancel only.
    if (t.id === editingId) {
      actions.append(
        actionButton('todo-save pill sm signal', 'Save', 'Save todo', () => void commitEdit(t)),
        actionButton('todo-cancel linkbtn', 'Cancel', 'Cancel edit', () =>
          rerenderFocusingAfterResolve(t.id, () => resolveEdit()),
        ),
      );
      return actions;
    }

    if (t.status === 'active') {
      const active = activeOf(ordered);
      const ai = active.findIndex((x) => x.id === t.id);
      const up = actionButton('todo-up iconbtn', '↑', 'Move up', () => moveActive(ordered, t, -1));
      up.disabled = ai <= 0;
      const down = actionButton('todo-down iconbtn', '↓', 'Move down', () => moveActive(ordered, t, 1));
      down.disabled = ai === active.length - 1;
      const edit = actionButton('todo-edit iconbtn', '✎', 'Edit todo', () => {
        editingId = t.id;
        rerenderFocusing(t.id, '.tx');
      });
      // Send pastes the todo into the agent's input WITHOUT submitting (§9.3 submit:false /
      // §16.2 Insert), then moves focus to the terminal so the user can edit or augment it
      // before submitting themselves (§24.2.1).
      const send = actionButton('todo-send pill sm signal', 'Send', 'Send todo to agent', () =>
        doInject(t.text, false),
      );
      actions.append(up, down, edit, send);
    }

    if (t.id === confirmingDeleteId) {
      actions.append(
        actionButton('todo-delete-confirm pill sm', 'Confirm delete?', 'Confirm delete', () =>
          beginPendingDelete(t),
        ),
        actionButton('todo-delete-cancel linkbtn', 'Cancel', 'Cancel delete', () => {
          confirmingDeleteId = null;
          rerenderFocusing(t.id, '.todo-delete');
        }),
      );
    } else {
      actions.append(
        actionButton('todo-delete iconbtn', '×', 'Delete todo', () => {
          confirmingDeleteId = t.id;
          rerenderFocusing(t.id, '.todo-delete-confirm');
        }),
      );
    }
    return actions;
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

  // A confirmed-but-not-yet-committed delete: the row is an Undo affordance for the window.
  function renderPendingDelete(t: TodoItem): HTMLElement {
    const row = document.createElement('div');
    row.className = 'todo pending-delete';
    row.dataset.todoId = t.id;
    const note = document.createElement('span');
    note.className = 'deleted-note';
    note.textContent = 'Deleted';
    const undo = actionButton('todo-undo linkbtn', 'Undo', 'Undo delete', () => cancelPendingDelete(t.id));
    row.append(note, undo);
    return row;
  }

  function beginPendingDelete(t: TodoItem): void {
    confirmingDeleteId = null;
    // Capture the item's own repo (t.repoKey), not the live cwd, so a mid-window swap still
    // deletes from the right list (§16.3); the delete fires only when the window elapses.
    pendingDelete.set(
      t.id,
      setTimeout(() => {
        pendingDelete.delete(t.id);
        // On a rejected invoke (main restart) keep the current list; never an unhandled rejection.
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
    const row = document.createElement('div');
    row.className = `todo${done ? ' done' : ''}`;
    row.dataset.todoId = t.id;
    row.draggable = t.status === 'active' && editingId === null;

    const chk = document.createElement('button');
    chk.className = 'chk';
    chk.setAttribute('role', 'checkbox');
    chk.setAttribute('aria-checked', String(done));
    chk.setAttribute('aria-label', done ? 'Mark todo active' : 'Mark todo done');
    chk.addEventListener('click', async () => {
      try {
        setTodos(await monitor.todoSetStatus(t.repoKey, t.id, done ? 'active' : 'done'));
      } catch {
        // IPC failure (main restart): leave the UI unchanged, never an unhandled rejection.
      }
    });

    const body = document.createElement('div');
    body.className = 'body';
    const tx = document.createElement('div');
    tx.className = 'tx';
    tx.textContent = t.text;
    if (t.id === editingId) {
      tx.contentEditable = 'true';
      tx.tabIndex = 0; // make it programmatically focusable (a11y focus move on enter-edit)
      tx.classList.add('editing');
      // Name the in-place editor for assistive tech (the ✎ that named the action is gone).
      tx.setAttribute('role', 'textbox');
      tx.setAttribute('aria-label', 'Edit todo text');
      tx.setAttribute('aria-multiline', 'true');
      tx.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void commitEdit(t, row);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          // Re-render with a focus target (the row's edit button) so Escape-cancel doesn't drop
          // focus to <body> — matches the Cancel button's behavior (WCAG 2.4.3, §16.4).
          rerenderFocusingAfterResolve(t.id, () => resolveEdit());
        }
      });
    }
    const src = document.createElement('div');
    src.className = 'src';
    src.textContent = provenanceText(t.source);
    body.append(tx, src);

    row.append(chk, body, renderActions(t, ordered));
    return row;
  }

  // The relocated template control (§4.1/§9.1): a collapsed "From template ▾" disclosure that
  // reveals a named picker + Add — so the resting composer is just the manual-add field (anti-
  // clutter). Rendered only when main offered templates (it gates them to an active step), so the
  // toggle's mere presence means "a step is active and has templates."
  function renderTemplatePicker(): void {
    if (templates.length === 0) return;

    const wrap = document.createElement('div');
    wrap.className = `todo-tmpl${templateOpen ? ' open' : ''}`;

    const toggle = document.createElement('button');
    toggle.className = 'tmpl-toggle linkbtn';
    toggle.setAttribute('aria-expanded', String(templateOpen));
    toggle.setAttribute('aria-controls', 'todo-tmpl-picker');
    toggle.setAttribute('aria-label', 'Add todos from a template');
    const car = document.createElement('span');
    car.className = 'car';
    car.setAttribute('aria-hidden', 'true');
    car.textContent = '▾';
    toggle.append(document.createTextNode('From template '), car);
    toggle.addEventListener('click', () => {
      templateOpen = !templateOpen;
      focusAfterRender = () =>
        todoListEl.querySelector<HTMLElement>(templateOpen ? '.tmpl-pick' : '.tmpl-toggle')?.focus();
      renderTodos();
    });
    wrap.append(toggle);

    if (templateOpen) {
      const group = document.createElement('div');
      group.className = 'tmpl-picker';
      group.id = 'todo-tmpl-picker';
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

      const select = document.createElement('select');
      select.className = 'tmpl-pick';
      select.setAttribute('aria-label', 'Todo template');
      for (const t of templates) {
        const opt = document.createElement('option');
        opt.value = t.ref;
        opt.textContent = t.name;
        select.append(opt);
      }
      const sel = templateSelected ?? templateDefault;
      if (sel && templates.some((t) => t.ref === sel)) select.value = sel;
      select.addEventListener('change', () => (templateSelected = select.value));

      const add = document.createElement('button');
      add.className = 'tmpl-add pill sm signal';
      add.textContent = 'Add todos';
      add.addEventListener('click', () => {
        if (!currentRepoKey) return;
        add.disabled = true;
        // Instantiate the chosen template; main silently skips already-present items. Keep the
        // picker open (operator decision) — setTodos re-renders and the disclosure persists.
        void monitor.instantiateTemplate(currentRepoKey, select.value).then(setTodos);
      });

      group.append(select, add);
      wrap.append(group);
    }

    todoListEl.appendChild(wrap);
  }

  function renderTodos(): void {
    todoListEl.replaceChildren();

    if (pendingRepoKey !== null) {
      const notice = document.createElement('div');
      notice.className = 'swap-blocked';
      notice.textContent = 'Directory changed — save or cancel this edit to switch todo lists.';
      todoListEl.appendChild(notice);
    }

    // Manual add (§16.4): a hand-write row → todoAdd {type:'manual'}.
    const addRow = document.createElement('div');
    addRow.className = 'todo-add';
    const input = document.createElement('textarea');
    input.id = 'todo-new';
    input.className = 'todo-new';
    input.rows = 1;
    input.setAttribute('aria-label', 'New todo');
    input.placeholder = 'Add a todo…';
    const addBtn = document.createElement('button');
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
    addBtn.addEventListener('click', () => void submitAdd());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void submitAdd();
      }
    });
    addRow.append(input, addBtn);
    todoListEl.appendChild(addRow);

    renderTemplatePicker();

    const list = document.createElement('div');
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

  // HTML5 drag reorder of the active rows (§16.4); the ↑/↓ buttons are the keyboard/a11y
  // path. The reordered ids persist via todo:reorder. Reorders within the active run only, so
  // dropping near an inline done row never shoves it (§16.4).
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

  // Render the panel immediately so the manual-add row is present from mount, before any repo
  // key is known (refresh() is repo-gated; without this the Todo tab is blank until OSC 7).
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
