import type { TodoItem, TodoStatus } from '../../src/shared/ipc';

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
