import type { ControllerLoopMessage, ControllerWorkStatus } from './ipc';

export function isControllerIssueNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isControllerWorkStatus(value: unknown): value is ControllerWorkStatus {
  const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const unavailable = (v: Record<string, unknown>) => v.availability === 'loading' || v.availability === 'unavailable';
  if (!record(value)) return false;
  if (value.unavailableReason !== undefined && value.unavailableReason !== 'message-too-large') return false;
  const { flow, ticket, activity, attention, error, loopMessage } = value;
  if (!record(flow) || !(unavailable(flow) || (flow.availability === 'known' && typeof flow.name === 'string' && typeof flow.step === 'string' && typeof flow.assignment === 'string' && ['unassigned', 'assigned', 'completed', 'unavailable'].includes(flow.assignment)))) return false;
  if (!record(ticket)) return false;
  if (!unavailable(ticket) && ticket.availability !== 'none') {
    if (ticket.availability !== 'known' || !isControllerIssueNumber(ticket.number) || !record(ticket.title)) return false;
    if (!unavailable(ticket.title) && !(ticket.title.availability === 'known' && typeof ticket.title.text === 'string')) return false;
  }
  return typeof activity === 'string' && ['active', 'quiet', 'unavailable'].includes(activity) &&
    (attention === null || (record(attention) && typeof attention.status === 'string' && Array.isArray(attention.reasons) && attention.reasons.every(reason => typeof reason === 'string'))) &&
    (error === null || (record(error) && typeof error.reason === 'string')) &&
    (loopMessage === undefined || loopMessage === null || isControllerLoopMessage(loopMessage));
}

function isControllerLoopMessage(value: unknown): value is ControllerLoopMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { id, kind, reason } = value as Record<string, unknown>;
  return typeof id === 'string' && id.length > 0 && (kind === 'error' || kind === 'notice') && typeof reason === 'string';
}

export const CONTROLLER_OVERSIZED_STATUS_TEXT = 'Status unavailable: message exceeds 1 MiB. Open the terminal for the full reason.';
