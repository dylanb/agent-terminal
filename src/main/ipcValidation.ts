// Trust-boundary validation for renderer→main IPC (§6). The renderer is sandboxed
// and single today, but unvalidated cols/rows reach native ptyProcess.resize and a
// non-positive/NaN value throws an uncaught exception in the main process.

import {
  SESSION_ID,
  type AgentInjectMsg,
  type CaptureCommandMsg,
  type CommandsRequestMsg,
  type DismissAllMsg,
  type DismissMsg,
  type MonitorCaptureMsg,
  type PtyInputMsg,
  type PtyResizeMsg,
} from '../shared/ipc';

function isRecord(m: unknown): m is Record<string, unknown> {
  return typeof m === 'object' && m !== null;
}

function isLiveSession(m: Record<string, unknown>): boolean {
  return m.sessionId === SESSION_ID;
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

export function isValidInput(m: unknown): m is PtyInputMsg {
  return isRecord(m) && isLiveSession(m) && typeof m.data === 'string';
}

export function isValidResize(m: unknown): m is PtyResizeMsg {
  return isRecord(m) && isLiveSession(m) && isPositiveInt(m.cols) && isPositiveInt(m.rows);
}

export function isValidInject(m: unknown): m is AgentInjectMsg {
  return isRecord(m) && isLiveSession(m) && typeof m.text === 'string' && typeof m.submit === 'boolean';
}

export function isValidCapture(m: unknown): m is MonitorCaptureMsg {
  return isRecord(m) && isLiveSession(m) && typeof m.text === 'string' && m.source === 'selection';
}

export function isValidCommandsRequest(m: unknown): m is CommandsRequestMsg {
  return isRecord(m) && isLiveSession(m);
}

export function isValidCaptureCommand(m: unknown): m is CaptureCommandMsg {
  return isRecord(m) && isLiveSession(m) && typeof m.commandId === 'string';
}

export function isValidDismiss(m: unknown): m is DismissMsg {
  return isRecord(m) && isLiveSession(m) && typeof m.eventId === 'string';
}

export function isValidDismissAll(m: unknown): m is DismissAllMsg {
  return isRecord(m) && isLiveSession(m);
}
