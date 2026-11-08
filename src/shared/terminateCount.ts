import type { FlowStateView } from './ipc';
import { isSelectionLocked } from './flowStarted';

/** How many todos Terminate deletes, as its confirmation states it: every todo of the repository. */
export function terminateTodoCount(todos: readonly unknown[]): number {
  return todos.length;
}

/** Whether Terminate is offered: on a running or finished flow, and on a begun run held at a load error, which has it as
 *  its route back to not started. The strip offers it, the operation accepts it, and `read_state` reports its count,
 *  all by this one rule. */
export function terminateOffered(view: Pick<FlowStateView, 'status' | 'runStarted'>): boolean {
  return view.status === 'in_progress' || view.status === 'done' || (view.status === 'error' && isSelectionLocked(view.runStarted));
}
