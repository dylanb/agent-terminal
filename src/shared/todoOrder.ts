import type { TodoItem } from './ipc';

export function outstandingTodoOrder(items: readonly Pick<TodoItem, 'id' | 'status'>[], ids: readonly string[]): string[] {
  let next = 0;
  return items.map(item => item.status === 'done' ? item.id : ids[next++]);
}
