import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../shared/controllerStatus';
import type { ControllerWorkStatus } from '../../shared/ipc';

export interface WorkCondition {
  statusClass: 'needs-human' | 'error' | 'notice';
  title: string;
  reasons: readonly string[];
  loopMessageId?: string;
}

export function workConditions(work: ControllerWorkStatus | undefined): WorkCondition[] {
  return [
    ...(work?.attention ? [{ statusClass: 'needs-human' as const, title: `Human needed: ${work.attention.status}`, reasons: work.attention.reasons }] : []),
    ...(work?.error ? [{ statusClass: 'error' as const, title: 'Error', reasons: [work.error.reason] }] : []),
    ...(work?.loopMessage ? [{
      statusClass: work.loopMessage.kind, title: work.loopMessage.kind === 'error' ? 'Loop error' : 'Notice',
      reasons: [work.loopMessage.reason], loopMessageId: work.loopMessage.id,
    }] : []),
  ];
}

export function attentionText(work: ControllerWorkStatus | undefined): string {
  if (work?.unavailableReason) return CONTROLLER_OVERSIZED_STATUS_TEXT;
  return workConditions(work).flatMap(condition => [condition.title, ...condition.reasons]).join('. ');
}

export function attentionUpdate(previous: string, current: string): string | undefined {
  if (current === previous) return undefined;
  if (current) return current;
  return previous === CONTROLLER_OVERSIZED_STATUS_TEXT ? 'Status available: no attention or error reported' : 'Attention and error cleared';
}
