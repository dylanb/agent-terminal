// Trust-boundary validation for renderer→main IPC (§6). The renderer is sandboxed
// and single today, but unvalidated cols/rows reach native ptyProcess.resize and a
// non-positive/NaN value throws an uncaught exception in the main process.

import path from 'node:path';
import {
  SESSION_ID,
  type AgentInjectMsg,
  type CaptureCommandMsg,
  type CaptureLastMsg,
  type ClearCommandsMsg,
  type CommandsRequestMsg,
  type DismissAllMsg,
  type DismissMsg,
  type FlowRequestMsg,
  type FlowProvideInputMsg,
  type TodoTemplateListMsg,
  type TodoTemplateInstantiateMsg,
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

export function isValidCaptureLast(m: unknown): m is CaptureLastMsg {
  return isRecord(m) && isLiveSession(m);
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

/** Flow lifecycle (§24.2.2). `repoKey` scopes the flow to the terminal's current repo and becomes
 *  a filesystem path in flowState, so it gets the same safe-path guard as the todo channels. */
export function isValidFlowRequest(m: unknown): m is FlowRequestMsg {
  return isRecord(m) && isLiveSession(m) && isSafeRepoKey(m.repoKey);
}

/** flow:provideInput (§18.4 / §24.2.3 T3): a flow request plus a `values` record whose every value
 *  is a string (the typed input answers persisted to flow-state). */
export function isValidFlowProvideInput(m: unknown): m is FlowProvideInputMsg {
  return (
    isRecord(m) &&
    isLiveSession(m) &&
    isSafeRepoKey(m.repoKey) &&
    isRecord(m.values) &&
    !Array.isArray(m.values) &&
    Object.values(m.values).every((v) => typeof v === 'string')
  );
}

/** todoTemplate:list (§6): a live session + a safe repoKey (the flow dir is resolved from it). */
export function isValidTemplateList(m: unknown): m is TodoTemplateListMsg {
  return isRecord(m) && isLiveSession(m) && isSafeRepoKey(m.repoKey);
}

/** todoTemplate:instantiate (§6/§21.2): a safe repoKey + a non-empty `ref` with no traversal
 *  (the loader escape-guards too, but reject `..` at the boundary as defense-in-depth). */
export function isValidTemplateInstantiate(m: unknown): m is TodoTemplateInstantiateMsg {
  return (
    isRecord(m) &&
    isLiveSession(m) &&
    isSafeRepoKey(m.repoKey) &&
    typeof m.ref === 'string' &&
    m.ref.length > 0 &&
    !m.ref.split(/[/\\]/).includes('..')
  );
}

// ---- todo:* validators (§16.3 / §16.4). repoKey is threaded on every mutation. ----

/** A repoKey is a main-derived absolute repo/cwd path; it becomes a filesystem write path
 *  in todoStore, so reject non-absolute or traversal-laden keys at the boundary (§6). */
function isSafeRepoKey(v: unknown): v is string {
  return typeof v === 'string' && path.isAbsolute(v) && !v.split(/[/\\]/).includes('..');
}

function isTodoBase(m: unknown): m is Record<string, unknown> {
  return isRecord(m) && isLiveSession(m) && isSafeRepoKey(m.repoKey);
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
  return (
    isTodoBase(m) &&
    typeof m.id === 'string' &&
    (m.status === 'active' || m.status === 'in_progress' || m.status === 'done')
  );
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
