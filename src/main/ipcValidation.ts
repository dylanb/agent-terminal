// Trust-boundary validation for renderer→main IPC (§6). The renderer is sandboxed
// and single today, but unvalidated cols/rows reach native ptyProcess.resize and a
// non-positive/NaN value throws an uncaught exception in the main process.

import {
  SESSION_ID,
  type AgentInjectMsg,
  type CaptureCommandMsg,
  type ClearCommandsMsg,
  type CommandsRequestMsg,
  type DismissAllMsg,
  type DismissMsg,
  type FlowRequestMsg,
  type MonitorCaptureMsg,
  type MonitorLearnChromeMsg,
  type PtyInputMsg,
  type PtyResizeMsg,
  type TodoAddMsg,
  type TodoDeleteMsg,
  type TodoListMsg,
  type TodoReorderMsg,
  type TodoSetStatusMsg,
  type TodoSourceType,
  type TodoUpdateMsg,
  type UiSetSettingsMsg,
  type ViewerReadMsg,
  type ViewerTreeMsg,
} from '../shared/ipc';

const TODO_SOURCE_TYPES: readonly TodoSourceType[] = [
  'manual',
  'selection',
  'report',
  'finding',
  'capture',
  'command-output',
];

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

export function isValidLearnChrome(m: unknown): m is MonitorLearnChromeMsg {
  return isRecord(m) && isLiveSession(m) && typeof m.eventId === 'string' && typeof m.sample === 'string';
}

/** Global UI prefs (§16.6) — no sessionId; validate only the present fields. */
export function isValidSetSettings(m: unknown): m is UiSetSettingsMsg {
  if (!isRecord(m) || !isRecord(m.settings)) return false;
  const s = m.settings;
  if ('splitRatio' in s && (typeof s.splitRatio !== 'number' || !Number.isFinite(s.splitRatio))) return false;
  if ('lastTab' in s && s.lastTab !== 'capture' && s.lastTab !== 'todo') return false;
  if ('theme' in s && s.theme !== 'light' && s.theme !== 'dark') return false;
  // Artifact viewer widths (§20.2) — finite numbers only, no NaN/Infinity/non-number.
  for (const k of ['artifactTreeWidth', 'artifactFullscreenTreeWidth'] as const) {
    if (k in s && (typeof s[k] !== 'number' || !Number.isFinite(s[k]))) return false;
  }
  return true;
}

export function isValidClearCommands(m: unknown): m is ClearCommandsMsg {
  return isRecord(m) && isLiveSession(m);
}

/** Flow lifecycle (§24.2.2) — sessionId only; the read/start/advance calls carry no other input. */
export function isValidFlowRequest(m: unknown): m is FlowRequestMsg {
  return isRecord(m) && isLiveSession(m);
}

// ---- todo:* validators (§16.3 / §16.4). repoKey is threaded on every mutation. ----

function isTodoBase(m: unknown): m is Record<string, unknown> {
  return isRecord(m) && isLiveSession(m) && typeof m.repoKey === 'string';
}

function isValidSource(s: unknown): boolean {
  if (s === undefined) return true;
  if (!isRecord(s)) return false;
  if (!TODO_SOURCE_TYPES.includes(s.type as TodoSourceType)) return false;
  if ('eventId' in s && typeof s.eventId !== 'string') return false;
  return true;
}

export function isValidTodoList(m: unknown): m is TodoListMsg {
  return isTodoBase(m);
}

export function isValidTodoAdd(m: unknown): m is TodoAddMsg {
  return isTodoBase(m) && typeof m.text === 'string' && isValidSource(m.source);
}

export function isValidTodoUpdate(m: unknown): m is TodoUpdateMsg {
  return isTodoBase(m) && typeof m.id === 'string' && typeof m.text === 'string';
}

export function isValidTodoReorder(m: unknown): m is TodoReorderMsg {
  return isTodoBase(m) && Array.isArray(m.orderedIds) && m.orderedIds.every((x) => typeof x === 'string');
}

export function isValidTodoSetStatus(m: unknown): m is TodoSetStatusMsg {
  return isTodoBase(m) && typeof m.id === 'string' && (m.status === 'active' || m.status === 'done');
}

export function isValidTodoDelete(m: unknown): m is TodoDeleteMsg {
  return isTodoBase(m) && typeof m.id === 'string';
}

// ---- viewer:* validators (§20.1/§20.2). ----

export function isValidViewerTree(m: unknown): m is ViewerTreeMsg {
  return isRecord(m) && isLiveSession(m) && (m.scope === 'curated' || m.scope === 'repo');
}

export function isValidViewerRead(m: unknown): m is ViewerReadMsg {
  return isRecord(m) && isLiveSession(m) && typeof m.relPath === 'string';
}
