import type { ControllerWorkStatus } from './ipc';
import { ACTIVITY_WORDS } from './controllerCardClassification';

export const REQUEST_RAISED_TEXT = 'Request raised';
export const DISCONNECTED_TEXT = 'Disconnected';

function flowChange(previous: ControllerWorkStatus['flow'], next: ControllerWorkStatus['flow']): string | undefined {
  if (previous.availability !== 'known' || next.availability !== 'known') return undefined;
  if (next.assignment === 'completed' && previous.assignment !== 'completed') return 'Completed';
  if (previous.step !== next.step) return `Step: ${next.step}`;
  if (previous.assignment === 'unassigned' && next.assignment === 'assigned') return 'Run started';
  return undefined;
}

/** The display text of each tracked change from `previous` to `next`, except a request appearing, which the transport pairs with its notification. */
export function statusChanges(previous: ControllerWorkStatus | undefined, next: ControllerWorkStatus): string[] {
  if (!previous) return [];
  const changes: string[] = [];
  if (previous.activity !== next.activity) changes.push(ACTIVITY_WORDS[next.activity]);
  if (!previous.error !== !next.error) changes.push(next.error ? 'Flow error' : 'Flow error cleared');
  if (previous.attention && !next.attention) changes.push('Request cleared');
  const flow = flowChange(previous.flow, next.flow);
  if (flow) changes.push(flow);
  return changes;
}
