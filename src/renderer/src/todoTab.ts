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

import type { MonitorApi, TodoItem, TodoSource } from '../../shared/ipc';
import { doInject, TODO_UNDO_MS } from './paneActions';

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
    'todoList' | 'todoAdd' | 'todoUpdate' | 'todoReorder' | 'todoSetStatus' | 'todoDelete'
  >;
}

/** Provenance line for a todo: where it came from, in the mockup's `.src` voice. */
function provenanceText(source: TodoSource | undefined): string {
  if (!source || source.type === 'manual') return 'manual';
  return `from ${source.type}`;
}

export function createTodoTab(deps: TodoTabDeps): TodoTab {
  const { todoListEl, todoCountEl, monitor } = deps;
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

  function actionButton(cls: string, label: string, ariaLabel: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.setAttribute('aria-label', ariaLabel);
    b.addEventListener('click', onClick);
    return b;
  }

  function reorderBy(ordered: TodoItem[], from: number, to: number): void {
    if (to < 0 || to >= ordered.length || !currentRepoKey) return;
    const ids = ordered.map((t) => t.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    void monitor.todoReorder(currentRepoKey, ids).then(setTodos);
  }

  /** The active row's nearest active neighbour in the full display order (skips done rows),
   *  or -1 when none — so ↑/↓ move within the active run and never cross a done row. */
  function neighbourActive(ordered: TodoItem[], index: number, dir: -1 | 1): number {
    for (let i = index + dir; i >= 0 && i < ordered.length; i += dir) {
      if (ordered[i].status === 'active') return i;
    }
    return -1;
  }

  function renderActions(t: TodoItem, ordered: TodoItem[], index: number): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'todo-actions';

    // Editing: the `.tx` is contenteditable in place; the cluster is Save/Cancel only.
    if (t.id === editingId) {
      actions.append(
        actionButton('todo-save pill sm signal', 'Save', 'Save todo', () => void commitEdit(t)),
        actionButton('todo-cancel linkbtn', 'Cancel', 'Cancel edit', () => resolveEdit()),
      );
      return actions;
    }

    if (t.status === 'active') {
      const up = actionButton('todo-up iconbtn', '↑', 'Move up', () =>
        reorderBy(ordered, index, neighbourActive(ordered, index, -1)),
      );
      up.disabled = neighbourActive(ordered, index, -1) === -1;
      const down = actionButton('todo-down iconbtn', '↓', 'Move down', () =>
        reorderBy(ordered, index, neighbourActive(ordered, index, 1)),
      );
      down.disabled = neighbourActive(ordered, index, 1) === -1;
      const edit = actionButton('todo-edit iconbtn', '✎', 'Edit todo', () => {
        editingId = t.id;
        renderTodos();
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
        actionButton('todo-delete-confirm pill sm send', 'Confirm delete?', 'Confirm delete', () =>
          beginPendingDelete(t),
        ),
        actionButton('todo-delete-cancel linkbtn', 'Cancel', 'Cancel delete', () => {
          confirmingDeleteId = null;
          renderTodos();
        }),
      );
    } else {
      actions.append(
        actionButton('todo-delete iconbtn', '×', 'Delete todo', () => {
          confirmingDeleteId = t.id;
          renderTodos();
        }),
      );
    }
    return actions;
  }

  async function commitEdit(t: TodoItem, el?: HTMLElement): Promise<void> {
    const tx = (el ?? rowEl(t.id))?.querySelector<HTMLElement>('.tx');
    const next = (tx?.textContent ?? t.text).trim();
    // The edit targets the list's own repo (t.repoKey), not the live cwd (§16.3).
    todos = await monitor.todoUpdate(t.repoKey, t.id, next);
    updateTodoCount();
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

  function renderTodoRow(t: TodoItem, ordered: TodoItem[], index: number): HTMLElement {
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
      setTodos(await monitor.todoSetStatus(t.repoKey, t.id, done ? 'active' : 'done'));
    });

    const body = document.createElement('div');
    body.className = 'body';
    const tx = document.createElement('div');
    tx.className = 'tx';
    tx.textContent = t.text;
    if (t.id === editingId) {
      tx.contentEditable = 'true';
      tx.classList.add('editing');
      tx.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void commitEdit(t, row);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          resolveEdit();
        }
      });
    }
    const src = document.createElement('div');
    src.className = 'src';
    src.textContent = provenanceText(t.source);
    body.append(tx, src);

    row.append(chk, body, renderActions(t, ordered, index));
    return row;
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
      setTodos(await monitor.todoAdd(currentRepoKey, text, { type: 'manual' }));
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

    const list = document.createElement('div');
    list.className = 'todos';
    // One flat list in stored order; done rows render inline (dimmed), not in a section.
    const ordered = [...todos].sort((a, b) => a.order - b.order);
    ordered.forEach((t, i) => list.appendChild(renderTodoRow(t, ordered, i)));
    todoListEl.appendChild(list);

    wireDragReorder(list, ordered);
  }

  // HTML5 drag reorder of the active rows (§16.4); the ↑/↓ buttons are the keyboard/a11y
  // path. The reordered ids persist via todo:reorder.
  // TODO(dylan): pointer drag is exercised only in the e2e (jsdom has no layout/DnD); the
  // keyboard reorder path is unit-tested. Recorded gap.
  function wireDragReorder(list: HTMLElement, ordered: TodoItem[]): void {
    let dragId: string | null = null;
    list.addEventListener('dragstart', (e) => {
      dragId = (e.target as HTMLElement).closest<HTMLElement>('.todo')?.dataset.todoId ?? null;
    });
    list.addEventListener('dragover', (e) => e.preventDefault());
    list.addEventListener('drop', (e) => {
      const targetId = (e.target as HTMLElement).closest<HTMLElement>('.todo')?.dataset.todoId;
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
