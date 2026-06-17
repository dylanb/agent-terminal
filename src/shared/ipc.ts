// Typed IPC contract (spec §6) — single source of truth for channel names and payloads.
// Every payload carries sessionId so multi-session support is additive later.

export type SessionId = string;

/** The single fixed session id in this version (§6). */
export const SESSION_ID: SessionId = 's1';

export const CH = {
  ptyData: 'pty:data',
  ptyInput: 'pty:input',
  ptyResize: 'pty:resize',
  ptyExit: 'pty:exit',
  monitorCapture: 'monitor:capture',
  monitorEvent: 'monitor:event',
  monitorEventRemoved: 'monitor:eventRemoved',
  monitorUpdate: 'monitor:update',
  monitorReplay: 'monitor:replay',
  monitorCurrentRepo: 'monitor:currentRepo',
  monitorCommands: 'monitor:commands',
  monitorCommandsChanged: 'monitor:commandsChanged',
  monitorCaptureCommandText: 'monitor:captureCommandText',
  monitorDismiss: 'monitor:dismiss',
  monitorDismissAll: 'monitor:dismissAll',
  monitorLearnChrome: 'monitor:learnChrome',
  agentInject: 'agent:inject',
  uiGetSettings: 'ui:getSettings',
  uiSetSettings: 'ui:setSettings',
  cwdChanged: 'cwd:changed',
  monitorClearCommands: 'monitor:clearCommands',
  todoList: 'todo:list',
  todoAdd: 'todo:add',
  todoUpdate: 'todo:update',
  todoReorder: 'todo:reorder',
  todoSetStatus: 'todo:setStatus',
  todoDelete: 'todo:delete',
} as const;

/** Action-window tabs (§16.1). */
export type TabId = 'capture' | 'todo';

/**
 * Global UI preferences (§16.6) — the one piece of state outside the repo,
 * persisted to userData. `splitRatio` is the terminal pane's width fraction.
 * Carries no sessionId: these are app-wide, not per-session (deliberate §16.6
 * exception to the §6 "every payload carries sessionId" rule).
 */
export type Theme = 'light' | 'dark';

export interface UiSettings {
  splitRatio: number;
  lastTab: TabId;
  theme: Theme;
}

export const DEFAULT_UI_SETTINGS: UiSettings = { splitRatio: 0.65, lastTab: 'capture', theme: 'light' };

export interface UiSetSettingsMsg {
  settings: Partial<UiSettings>;
}

// ---- Todo lists (§16.3 / §16.4) ----

export type TodoStatus = 'active' | 'done';

/** Where a todo came from (§16.3): manual entry, a selection capture, or a semantic event. */
export type TodoSourceType = 'manual' | 'selection' | 'report' | 'finding' | 'capture' | 'command-output';

export interface TodoSource {
  type: TodoSourceType;
  /** The source MonitorEvent id, when added from a capture (§16.2). */
  eventId?: string;
}

/**
 * A persistent, repo-scoped todo (§16.3). `order` is the sort key within a status
 * group (active list / Done section). Strict-typed, no `any`, per CLAUDE.md.
 */
export interface TodoItem {
  id: string;
  repoKey: string;
  text: string;
  status: TodoStatus;
  order: number;
  createdAt: string;
  source?: TodoSource;
}

export interface TodoListMsg {
  sessionId: SessionId;
  repoKey: string;
}

export interface TodoAddMsg {
  sessionId: SessionId;
  repoKey: string;
  text: string;
  source?: TodoSource;
}

export interface TodoUpdateMsg {
  sessionId: SessionId;
  repoKey: string;
  id: string;
  text: string;
}

export interface TodoReorderMsg {
  sessionId: SessionId;
  repoKey: string;
  orderedIds: string[];
}

export interface TodoSetStatusMsg {
  sessionId: SessionId;
  repoKey: string;
  id: string;
  status: TodoStatus;
}

export interface TodoDeleteMsg {
  sessionId: SessionId;
  repoKey: string;
  id: string;
}

export interface PtyDataMsg {
  sessionId: SessionId;
  data: string;
}

export interface PtyInputMsg {
  sessionId: SessionId;
  data: string;
}

export interface PtyResizeMsg {
  sessionId: SessionId;
  cols: number;
  rows: number;
}

export interface PtyExitMsg {
  sessionId: SessionId;
  code: number;
}

export interface Cell {
  x: number;
  y: number;
}

export type BufferType = 'normal' | 'alternate';

/** Best-effort provenance only (§7.3/§8.4) — never re-extract content from these coordinates. */
export interface SelectionRange {
  start: Cell;
  end: Cell;
  baseY: number;
  bufferType: BufferType;
}

export interface MonitorCaptureMsg {
  sessionId: SessionId;
  text: string;
  range: SelectionRange | null;
  source: 'selection';
}

/**
 * Typed semantic/command regions plus the manual `capture` (§15.4 / v2.6).
 * `report` is an agent report group; `finding` is one individually-actionable
 * item inside it (linked via `parentId`). Permission/question detection was
 * removed in v2.6 (false-positive-prone); `completion` stays reserved/unused.
 */
export type MonitorEventType =
  | 'capture'
  | 'report'
  | 'finding'
  | 'tool-use'
  | 'diff'
  | 'completion'
  | 'command-output';

/** Provenance: manual selection, semantic adapter, generic heuristic, or OSC 133 marks (§15.4). */
export type MonitorEventSource = 'selection' | 'shadow-scan' | 'shell-integration' | 'heuristic';

/** Event shape emitted on monitor:event (§8.4/§15.4). `text` is the durable payload. */
export interface MonitorEvent {
  id: string;
  sessionId: SessionId;
  type: MonitorEventType;
  source: MonitorEventSource;
  text: string;
  range: SelectionRange | null;
  /** A `finding`'s parent `report` id; null for top-level events (§15.4 / v2.6). */
  parentId: string | null;
  /** True when scrollback trim lost part of the region before extraction (§15.2). */
  truncated: boolean;
  capturedAt: string;
}

/** A completed or running command segmented by OSC 133 marks (§15.5). Newest-last. */
export interface CommandSummary {
  id: string;
  sessionId: SessionId;
  command: string;
  exitCode: number | null;
  running: boolean;
  startedAt: number;
  truncated: boolean;
}

export interface CommandsRequestMsg {
  sessionId: SessionId;
}

/** Fired when a command span opens/closes so the pane re-pulls history (§15.5). */
export interface CommandsChangedMsg {
  sessionId: SessionId;
}

export interface CaptureCommandMsg {
  sessionId: SessionId;
  commandId: string;
}

/** Output text of a captured command (§16.2); returned null when the id is unknown/trimmed. */
export interface CommandCaptureResult {
  text: string;
  truncated: boolean;
}

/** Dismiss a captured event; dismissing a `report` cascades to its findings (§15.6 / v2.6). */
export interface DismissMsg {
  sessionId: SessionId;
  eventId: string;
}

/** Dismiss every captured event in the pane (§15.6 / v2.6). */
export interface DismissAllMsg {
  sessionId: SessionId;
}

/** Clear the command-history list — Dismiss-all for commands (§16.2). */
export interface ClearCommandsMsg {
  sessionId: SessionId;
}

export interface MonitorEventMsg {
  sessionId: SessionId;
  event: MonitorEvent;
}

/**
 * A previously-emitted semantic event was retracted by the scanner because a later
 * capture supersedes it (its text is an exact prefix of the newer one — §15.3). The
 * pane drops the block; removing a `report` drops its nested findings with it.
 */
export interface MonitorEventRemovedMsg {
  sessionId: SessionId;
  eventId: string;
}

/**
 * The user marked a captured block as chrome (§15.x): main learns its leading glyphs
 * as chrome markers (so future furniture led by them is filtered) and retracts this
 * capture via monitor:eventRemoved. `sample` is the block's text.
 */
export interface MonitorLearnChromeMsg {
  sessionId: SessionId;
  eventId: string;
  sample: string;
}

/**
 * The agent's repo key changed (OSC 7 → §16.3); the action window re-pulls
 * `todo:list` for `repoKey`, blocking a swap while a todo edit is open (§16.3).
 */
export interface CwdChangedMsg {
  sessionId: SessionId;
  cwd: string;
  repoKey: string;
}

/** The agent's current repo, queried on pane mount (§16.3); null before the first
 *  OSC 7. The live `cwd:changed` broadcast fires only on key *change*, so a pane that
 *  mounts after the initial broadcast learns the repo only by asking. */
export interface RepoInfo {
  cwd: string;
  repoKey: string;
}

export type AgentState = 'active' | 'quiet';

export interface MonitorUpdateMsg {
  sessionId: SessionId;
  altScreen: boolean;
  bracketedPaste: boolean;
  agentState: AgentState;
  quietSince: number | null;
}

export interface AgentInjectMsg {
  sessionId: SessionId;
  text: string;
  submit: boolean;
}

/** Binds each main→renderer channel to its payload so emit sites stay type-checked (§6). */
export interface ChannelPayloads {
  'pty:data': PtyDataMsg;
  'pty:exit': PtyExitMsg;
  'monitor:event': MonitorEventMsg;
  'monitor:eventRemoved': MonitorEventRemovedMsg;
  'monitor:update': MonitorUpdateMsg;
  'monitor:commandsChanged': CommandsChangedMsg;
  'cwd:changed': CwdChangedMsg;
}

export type SendChannel = keyof ChannelPayloads;

// ---- Preload-exposed API surfaces (§6) ----

export interface TermApi {
  onData(cb: (data: string) => void): void;
  onExit(cb: (msg: PtyExitMsg) => void): void;
  input(data: string): void;
  resize(size: { cols: number; rows: number }): void;
}

export interface MonitorApi {
  capture(block: Omit<MonitorCaptureMsg, 'sessionId'>): void;
  onEvent(cb: (event: MonitorEvent) => void): void;
  /** A prior semantic event was retracted (superseded by a fuller capture, §15.3); drop its block. */
  onEventRemoved(cb: (eventId: string) => void): void;
  onUpdate(cb: (msg: MonitorUpdateMsg) => void): void;
  onExit(cb: (msg: PtyExitMsg) => void): void;
  replay(): Promise<MonitorEvent[]>;
  /** The agent's current repo (§16.3), or null before the first OSC 7. Queried on mount
   *  so the pane learns the repo key even when it missed the live `cwd:changed` broadcast. */
  currentRepo(): Promise<RepoInfo | null>;
  /** Compact command history (§15.5); re-pulled on each monitor:update tick and commandsChanged signal. */
  commands(): Promise<CommandSummary[]>;
  /** Mark-driven signal that a command span opened/closed; pane re-pulls history (§15.5). */
  onCommandsChanged(cb: () => void): void;
  /** A command's output text, for adding straight to a todo (§16.2); null on unknown/trimmed id. */
  captureCommandText(commandId: string): Promise<CommandCaptureResult | null>;
  /** Dismiss one captured event; dismissing a report cascades to its findings (§15.6). */
  dismiss(eventId: string): void;
  /** Dismiss every captured event (§15.6). */
  dismissAll(): void;
  /** Mark a captured block as chrome (§15.x): learn its leading glyphs as markers so
   *  future furniture is filtered, and retract this capture. */
  learnChrome(eventId: string, sample: string): void;
  inject(req: Omit<AgentInjectMsg, 'sessionId'>): void;
  /** Global UI prefs — split ratio + last tab (§16.6). */
  getSettings(): Promise<UiSettings>;
  setSettings(settings: Partial<UiSettings>): void;
  /** The agent's repo key changed (OSC 7 → §16.3); pane re-pulls its todo list. */
  onCwdChanged(cb: (msg: CwdChangedMsg) => void): void;
  /** Clear the command-history list — Dismiss-all for commands (§16.2). */
  clearCommands(): void;
  // Todo (§16.4) — repoKey threaded so an in-flight edit always targets its own repo.
  todoList(repoKey: string): Promise<TodoItem[]>;
  todoAdd(repoKey: string, text: string, source?: TodoSource): Promise<TodoItem[]>;
  todoUpdate(repoKey: string, id: string, text: string): Promise<TodoItem[]>;
  todoReorder(repoKey: string, orderedIds: string[]): Promise<TodoItem[]>;
  todoSetStatus(repoKey: string, id: string, status: TodoStatus): Promise<TodoItem[]>;
  todoDelete(repoKey: string, id: string): Promise<TodoItem[]>;
}

declare global {
  interface Window {
    term: TermApi;
    monitor: MonitorApi;
  }
}
