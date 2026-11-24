import type { FlowStateView } from './ipc';
import { isSelectionLocked } from './flowStarted';

export function terminateTodoCount(todos: readonly unknown[]): number {
  return todos.length;
}

export function terminateOffered(view: Pick<FlowStateView, 'status' | 'runStarted' | 'installationRetry'>): boolean {
  if (view.installationRetry !== undefined) return false;
  return view.status === 'in_progress' || view.status === 'done' || (view.status === 'error' && isSelectionLocked(view.runStarted));
}
