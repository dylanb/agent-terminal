// Todo tab (§16.3 / §16.4): persistent, repo-scoped todos with an active list, a
// collapsible Done section, manual add, reorder (buttons + HTML5 drag), edit-in-place,
// and the mid-edit repo-swap deferral. Owns all todo state (`todos`, `editingId`,
// `pendingRepoKey`, `currentRepoKey`); the Capture tab reaches it only through the
// narrow TodoSink surface, so the two tabs share state through one owner, not a scope.

import type { MonitorApi, TodoItem, TodoSource } from '../../shared/ipc';
import { doInject, TODO_UNDO_MS } from './paneActions';

/** The slice the Capture tab needs to push a capture into the list and undo it (§16.2). */
export interface TodoSink {
  currentRepoKey(): string | null;
  /** Add from a capture action; returns the new item (for Undo) or null. Refreshes count + list. */
  addFromCapture(text: string, source: TodoSource): Promise<TodoItem | null>;
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
    'todoList' | 'todoAdd' | 'todoUpdate' | 'todoReorder' | 'todoSetStatus' | 'todoDelete'
  >;
}

export function createTodoTab(deps: TodoTabDeps): TodoTab {
  const { todoListEl, todoCountEl, monitor } = deps;
  let currentRepoKey: string | null = null;
  let todos: TodoItem[] = [];
  // A repo swap is blocked while a todo edit is open (§16.3); the pending key is
  // applied once the edit resolves so the in-flight edit writes to its own repo.
  let editingId: string | null = null;
  let pendingRepoKey: string | null = null;
  // Delete is a two-step, undoable action (§16.4): × asks to confirm; confirming hides the
  // row behind an Undo for TODO_UNDO_MS and only then calls todoDelete. Both are render
  // state (survive a re-render), and the actual delete is deferred so Undo needs no re-add.
  let confirmingDeleteId: string | null = null;
  const pendingDelete = new Map<string, ReturnType<typeof setTimeout>>();

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

  function todoInjectActions(t: TodoItem): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'capture-actions';
    // Active → completing the todo marks it done; done → re-copy moves it back (§16.4).
    const nextStatus = t.status === 'active' ? 'done' : 'active';
    const insert = document.createElement('button');
    insert.className = 'todo-insert';
    insert.textContent = 'Insert into agent';
    insert.addEventListener('click', async () => {
      doInject(t.text, false);
      setTodos(await monitor.todoSetStatus(t.repoKey, t.id, nextStatus));
    });
    const submit = document.createElement('button');
    submit.className = 'todo-submit';
    submit.textContent = 'Insert & submit';
    submit.addEventListener('click', async () => {
      doInject(t.text, true);
      setTodos(await monitor.todoSetStatus(t.repoKey, t.id, nextStatus));
    });
    actions.append(insert, submit);
    return actions;
  }

  // Editing is render state, not a DOM mutation, so a mid-edit re-render (e.g. the
  // blocked-swap notice) preserves the open editor (§16.3).
  function renderEditing(t: TodoItem): HTMLElement {
    const item = document.createElement('div');
    item.className = 'todo-item editing';
    item.dataset.todoId = t.id;
    const textarea = document.createElement('textarea');
    textarea.className = 'todo-edit-area';
    textarea.value = t.text;
    const actions = document.createElement('div');
    actions.className = 'todo-actions';
    const save = document.createElement('button');
    save.className = 'todo-save';
    save.textContent = 'Save';
    save.addEventListener('click', async () => {
      // The edit targets the list's own repo (t.repoKey), not the live cwd (§16.3).
      const list = await monitor.todoUpdate(t.repoKey, t.id, textarea.value);
      todos = list;
      updateTodoCount();
      resolveEdit();
    });
    const cancel = document.createElement('button');
    cancel.className = 'todo-cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => resolveEdit());
    actions.append(save, cancel);
    item.append(textarea, actions);
    return item;
  }

  // A confirmed-but-not-yet-committed delete: the row is an Undo affordance for the window.
  function renderPendingDelete(t: TodoItem): HTMLElement {
    const item = document.createElement('div');
    item.className = 'todo-item pending-delete';
    item.dataset.todoId = t.id;
    const note = document.createElement('span');
    note.className = 'deleted-note';
    note.textContent = 'Deleted';
    const undo = document.createElement('button');
    undo.className = 'todo-undo';
    undo.textContent = 'Undo';
    undo.addEventListener('click', () => cancelPendingDelete(t.id));
    item.append(note, undo);
    return item;
  }

  function beginPendingDelete(t: TodoItem): void {
    confirmingDeleteId = null;
    // Capture the item's own repo (t.repoKey), not the live cwd, so a mid-window swap still
    // deletes from the right list (§16.3); the delete fires only when the window elapses.
    pendingDelete.set(
      t.id,
      setTimeout(() => {
        pendingDelete.delete(t.id);
        void monitor.todoDelete(t.repoKey, t.id).then(setTodos);
      }, TODO_UNDO_MS),
    );
    renderTodos();
  }

  function cancelPendingDelete(id: string): void {
    const timer = pendingDelete.get(id);
    if (timer) clearTimeout(timer);
    pendingDelete.delete(id);
    renderTodos(); // restored from `todos` — the server delete never ran
  }

  function renderTodoItem(t: TodoItem, ordered: TodoItem[], index: number): HTMLElement {
    if (pendingDelete.has(t.id)) return renderPendingDelete(t);
    if (t.id === editingId) return renderEditing(t);

    const item = document.createElement('div');
    item.className = `todo-item${t.status === 'done' ? ' done' : ''}`;
    item.dataset.todoId = t.id;

    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.textContent = '⠿';
    item.draggable = t.status === 'active';

    const text = document.createElement('span');
    text.className = 'todo-text';
    text.textContent = t.text;

    const actions = document.createElement('div');
    actions.className = 'todo-actions';

    if (t.status === 'active') {
      const up = document.createElement('button');
      up.className = 'todo-up';
      up.textContent = '↑';
      up.setAttribute('aria-label', 'Move up');
      up.disabled = index === 0;
      up.addEventListener('click', () => reorderBy(ordered, index, index - 1));
      const down = document.createElement('button');
      down.className = 'todo-down';
      down.textContent = '↓';
      down.setAttribute('aria-label', 'Move down');
      down.disabled = index === ordered.length - 1;
      down.addEventListener('click', () => reorderBy(ordered, index, index + 1));
      const edit = document.createElement('button');
      edit.className = 'todo-edit';
      edit.textContent = 'Edit';
      edit.addEventListener('click', () => {
        editingId = t.id;
        renderTodos();
      });
      actions.append(up, down, edit);
    }

    if (t.id === confirmingDeleteId) {
      const confirm = document.createElement('button');
      confirm.className = 'todo-delete-confirm';
      confirm.textContent = 'Confirm delete?';
      confirm.addEventListener('click', () => beginPendingDelete(t));
      const cancel = document.createElement('button');
      cancel.className = 'todo-delete-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => {
        confirmingDeleteId = null;
        renderTodos();
      });
      actions.append(confirm, cancel);
    } else {
      const del = document.createElement('button');
      del.className = 'todo-delete dismiss';
      del.textContent = '×';
      del.setAttribute('aria-label', 'Delete todo');
      del.addEventListener('click', () => {
        confirmingDeleteId = t.id;
        renderTodos();
      });
      actions.append(del);
    }

    item.append(handle, text, todoInjectActions(t), actions);
    return item;
  }

  function reorderBy(ordered: TodoItem[], from: number, to: number): void {
    if (to < 0 || to >= ordered.length || !currentRepoKey) return;
    const ids = ordered.map((t) => t.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    void monitor.todoReorder(currentRepoKey, ids).then(setTodos);
  }

  // Manual-add row + active list + collapsible Done section (§16.4).
  function renderTodos(): void {
    todoListEl.innerHTML = '';

    if (pendingRepoKey !== null) {
      const notice = document.createElement('div');
      notice.className = 'swap-blocked';
      notice.textContent = 'Directory changed — save or cancel this edit to switch todo lists.';
      todoListEl.appendChild(notice);
    }

    const addRow = document.createElement('div');
    addRow.className = 'todo-add';
    const input = document.createElement('textarea');
    input.id = 'todo-new';
    input.className = 'todo-new';
    input.setAttribute('aria-label', 'New todo');
    const addBtn = document.createElement('button');
    addBtn.id = 'todo-add-btn';
    addBtn.textContent = 'Add';
    addBtn.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text || !currentRepoKey) return;
      setTodos(await monitor.todoAdd(currentRepoKey, text, { type: 'manual' }));
      input.value = '';
    });
    addRow.append(input, addBtn);
    todoListEl.appendChild(addRow);

    const active = todos.filter((t) => t.status === 'active').sort((a, b) => a.order - b.order);
    const activeList = document.createElement('div');
    activeList.className = 'todo-active';
    active.forEach((t, i) => activeList.appendChild(renderTodoItem(t, active, i)));
    todoListEl.appendChild(activeList);

    const done = todos.filter((t) => t.status === 'done').sort((a, b) => a.order - b.order);
    const doneSection = document.createElement('details');
    doneSection.className = 'todo-done';
    const summary = document.createElement('summary');
    summary.textContent = `Done (${done.length})`;
    doneSection.appendChild(summary);
    done.forEach((t) => doneSection.appendChild(renderTodoItem(t, done, 0)));
    todoListEl.appendChild(doneSection);

    wireDragReorder(activeList, active);
  }

  // HTML5 drag reorder of the active list (§16.4); the up/down buttons are the
  // keyboard/a11y path. The reordered ids persist via todo:reorder.
  // TODO(dylan): pointer drag is exercised only in the §F e2e (plan PR5 5c) — jsdom
  // has no layout/DnD; the keyboard reorder path is unit-tested. Recorded gap.
  function wireDragReorder(list: HTMLElement, ordered: TodoItem[]): void {
    let dragId: string | null = null;
    list.addEventListener('dragstart', (e) => {
      dragId = (e.target as HTMLElement).closest<HTMLElement>('.todo-item')?.dataset.todoId ?? null;
    });
    list.addEventListener('dragover', (e) => e.preventDefault());
    list.addEventListener('drop', (e) => {
      const targetId = (e.target as HTMLElement).closest<HTMLElement>('.todo-item')?.dataset.todoId;
      if (!dragId || !targetId || dragId === targetId) return;
      const ids = ordered.map((t) => t.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0) return;
      reorderBy(ordered, from, to);
    });
  }

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
