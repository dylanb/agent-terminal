import type { TodoItem, TodoStatus } from '../../src/shared/ipc';

/** One todo per status given, in that order, each with its own id, text, order and creation time, so no two can be
 *  swapped unnoticed by a test that compares them (UI-STANDARDS.md §3.4 rule 4). */
export function distinctTodos(repoKey: string, statuses: TodoStatus[]): TodoItem[] {
  return statuses.map((status, i) => ({
    id: `todo-${i + 1}`,
    repoKey,
    text: `todo ${i + 1} (${status})`,
    status,
    order: (i + 1) * 10,
    createdAt: new Date(Date.UTC(2026, 10, 1, 9, i)).toISOString(),
  }));
}
