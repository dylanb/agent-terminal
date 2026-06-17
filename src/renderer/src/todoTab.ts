// Todo tab (§24.1 mockup-exact / §16.3): a flat, repo-scoped list of todos rendered in
// the converged mockup's language — a checkbox-circle (.chk) that toggles done, a body
// (.tx text + .src provenance), and a Send action on active rows. Owns the todo state
// (`todos`, `currentRepoKey`); the Capture tab reaches it only through the narrow
// TodoSink surface, so the two tabs share state through one owner, not a scope.
//
// Reorder, edit-in-place, manual add, and delete are deferred to §24.2.1 (main-process
// IPC for them still exists); restore them re-skinned into this card language, not the
// old chrome.

import type { MonitorApi, TodoItem, TodoSource } from '../../shared/ipc';
import { doInject } from './paneActions';

/** The slice the Capture tab needs to push a capture into the list (§16.2). */
export interface TodoSink {
  currentRepoKey(): string | null;
  /** Add from a capture action; returns the new item or null. Refreshes count + list. */
  addFromCapture(text: string, source: TodoSource): Promise<TodoItem | null>;
}

export interface TodoTab extends TodoSink {
  /** A repo-key change (§16.3): swap the displayed list. */
  onRepoChanged(repoKey: string): void;
  /** Re-pull the current repo's list (tab activation, external change signal). */
  refresh(): void;
}

export interface TodoTabDeps {
  todoListEl: HTMLElement;
  todoCountEl: HTMLElement;
  monitor: Pick<MonitorApi, 'todoList' | 'todoAdd' | 'todoSetStatus'>;
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

  function onRepoChanged(repoKey: string): void {
    currentRepoKey = repoKey;
    refresh();
  }

  function renderTodoRow(t: TodoItem): HTMLElement {
    const done = t.status === 'done';
    const row = document.createElement('div');
    row.className = `todo${done ? ' done' : ''}`;
    row.dataset.todoId = t.id;

    // The checkbox-circle toggles done ↔ active (§16.4 lifecycle, mockup affordance).
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
    const src = document.createElement('div');
    src.className = 'src';
    src.textContent = provenanceText(t.source);
    body.append(tx, src);

    row.append(chk, body);

    // Send pastes the todo into the agent's input WITHOUT submitting (§9.3 submit:false /
    // §16.2 Insert), then moves focus to the terminal so the user can edit or augment it
    // before submitting themselves (§24.2.1).
    if (!done) {
      const send = document.createElement('button');
      send.className = 'todo-send pill sm signal';
      send.textContent = 'Send';
      send.addEventListener('click', () => doInject(t.text, false));
      row.append(send);
    }
    return row;
  }

  function renderTodos(): void {
    todoListEl.replaceChildren();
    const list = document.createElement('div');
    list.className = 'todos';
    // One flat list in stored order; done rows render inline (dimmed), not in a section.
    [...todos]
      .sort((a, b) => a.order - b.order)
      .forEach((t) => list.appendChild(renderTodoRow(t)));
    todoListEl.appendChild(list);
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
  };
}
