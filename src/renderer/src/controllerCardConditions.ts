import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../shared/controllerStatus';
import type { ControllerTerminal, ControllerWorkStatus } from '../../shared/ipc';

export interface WorkCondition {
  statusClass: 'needs-human' | 'error';
  title: string;
  reasons: readonly string[];
}

export function workConditions(work: ControllerWorkStatus | undefined): WorkCondition[] {
  return [
    ...(work?.attention ? [{ statusClass: 'needs-human' as const, title: `Human needed: ${work.attention.status}`, reasons: work.attention.reasons }] : []),
    ...(work?.error ? [{ statusClass: 'error' as const, title: 'Error', reasons: [work.error.reason] }] : []),
  ];
}

export function attentionText(terminal: ControllerTerminal): string {
  if (terminal.work?.unavailableReason) return CONTROLLER_OVERSIZED_STATUS_TEXT;
  return workConditions(terminal.work).flatMap(condition => [condition.title, ...condition.reasons]).join('. ');
}

export function attentionUpdate(previous: string, current: string): string | undefined {
  if (current === previous) return undefined;
  if (current) return current;
  return previous === CONTROLLER_OVERSIZED_STATUS_TEXT ? 'Status available: no attention or error reported' : 'Attention and error cleared';
}
