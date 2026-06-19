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
  captureLast: 'capture:last',
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
  viewerTree: 'viewer:tree',
  viewerRead: 'viewer:read',
  flowState: 'flow:state',
  flowStart: 'flow:start',
  flowAdvance: 'flow:advance',
  flowRestart: 'flow:restart',
  todoTemplateList: 'todoTemplate:list',
  todoTemplateInstantiate: 'todoTemplate:instantiate',
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
  /** Artifact viewer tree-pane width in px (§20.2), drag/keyboard-resizable & persisted. */
  artifactTreeWidth: number;
  /** Full-screen tree-popout width in px (§20.2); absent until set — default is 30% of the viewport. */
  artifactFullscreenTreeWidth?: number;
}

export const DEFAULT_UI_SETTINGS: UiSettings = { splitRatio: 0.65, lastTab: 'capture', theme: 'light', artifactTreeWidth: 248 };

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

/** "Capture last report" (§21.1): run report-detection on demand; resolves to the single
 *  latest report + findings (replacing the prior capture), or [] when none is detected. */
export interface CaptureLastMsg {
  sessionId: SessionId;
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

// ---- Artifact viewer (§20.1/§20.2) ----

/** Per-file provenance tags (D8): tracked-but-changed in the working tree, under the
 *  agent-loop, or part of the current PR. Empty/omitted when none apply. */
export type ArtifactProvenance = 'changed' | 'loop' | 'pr';

/** One node of the hierarchical artifact tree (§20.1). A directory carries `children`;
 *  a file carries its `provenance` tags. `relPath` is unique within a tree and is the
 *  id the renderer passes back to `viewer:read`. */
export interface ArtifactNode {
  name: string;
  relPath: string;
  kind: 'file' | 'dir';
  children?: ArtifactNode[];
  provenance?: ArtifactProvenance[];
}

/** Curated (loop ∪ PR ∪ working-tree changes) vs. the whole repo (D8). */
export type ArtifactScope = 'curated' | 'repo';

export interface ArtifactTree {
  /** Absolute discovery root: the repo root, or the cwd when outside a repo. */
  root: string;
  /** False outside a git repo — the tree is the whole cwd dir, no curated scope/provenance. */
  isRepo: boolean;
  scope: ArtifactScope;
  nodes: ArtifactNode[];
}

export type ViewerFileKind = 'markdown' | 'code';

export interface ViewerFile {
  relPath: string;
  name: string;
  kind: ViewerFileKind;
  lang?: string;
  body: string;
  /** 1-based current-file lines added/modified vs HEAD (code files in a repo; §20.2). Absent when none. */
  changedLines?: number[];
}

export interface ViewerTreeMsg {
  sessionId: SessionId;
  scope: ArtifactScope;
}

export interface ViewerReadMsg {
  sessionId: SessionId;
  relPath: string;
}

// ---- Flow lifecycle (§18.2 / §24.2.2) ----

/** A manual step's lifecycle: not started, being worked, or completed (terminal) — §18.2.
 *  `error` is not a step state but a load failure: the `flow.yaml` (§18.1) was absent,
 *  malformed, or schema-invalid, so there is no step to drive (§24.2.2 S2). */
export type FlowStatus = 'not_started' | 'in_progress' | 'done' | 'error';

/** The flow's live view (§22.3 status strip): the current step's name, its 1-based
 *  `position` within `total` steps, and its `status`. S2 sources the step from
 *  `<worktree>/.agent-terminal/flow.yaml` (§18.1); on a load failure `status` is
 *  `error` and `error` carries the human-readable reason (position/total 0). */
export interface FlowStateView {
  stepName: string;
  position: number;
  total: number;
  status: FlowStatus;
  error?: string;
  /** A one-shot transient notice carried only on a `start`/`restart` response — e.g. the §19.3
   *  running-process refusal when a skill couldn't be injected over a busy shell (§24.2.2 S4).
   *  Never part of `state()`: the strip shows it once, then a re-pull clears it. */
  notice?: string;
  /** The active step's bound `todo_template:` ref (§18.6), when it declares one — the default the
   *  on-demand todo-template picker offers while the step is active (§6/§4.1). */
  templateRef?: string;
}

/** flow:state/start/advance/restart request. `repoKey` scopes the flow to the terminal's current
 *  repo (§16.3), threaded like the todo channels so the flow follows the cwd (§6). */
export interface FlowRequestMsg {
  sessionId: SessionId;
  repoKey: string;
}

/** A discoverable todo template (§4.1/§21.2): `ref` is the instantiate id (filename without
 *  `.md`); `name` is the user-facing label (its `# H1`, else a humanized filename). */
export interface TodoTemplateRef {
  ref: string;
  name: string;
}

/** todoTemplate:list response (§4.1/§6): the templates offered to the on-demand picker, plus the
 *  active step's bound `todo_template:` as the picker's default selection. Main gates this to a
 *  step that is `in_progress` (empty otherwise), so the todo widget needs no flow-state awareness. */
export interface TodoTemplateList {
  templates: TodoTemplateRef[];
  defaultRef?: string;
}

/** todoTemplate:list request (§6): the templates co-located with the repo's flow.yaml (§18.6).
 *  `repoKey` resolves the flow dir local-first-then-global (deviates from the v2.27 global-only
 *  sketch, since templates are now co-located). */
export interface TodoTemplateListMsg {
  sessionId: SessionId;
  repoKey: string;
}

/** todoTemplate:instantiate request (§6/§21.2): instantiate the named template `ref` (resolved
 *  co-located with the flow.yaml, §18.6) into `repoKey`'s todo list, returning the fresh list. */
export interface TodoTemplateInstantiateMsg {
  sessionId: SessionId;
  repoKey: string;
  ref: string;
}

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
  /** The agent's current repo (§16.3). Queried on mount so the pane learns the repo key even when
   *  it missed the live `cwd:changed` broadcast. Main backstops with the shell spawn cwd, so this
   *  resolves to a RepoInfo even before the first OSC 7; the `| null` is reserved for an
   *  unresolvable session (no live PTY) and is not the normal pre-OSC-7 case. */
  currentRepo(): Promise<RepoInfo | null>;
  /** Compact command history (§15.5), pulled on demand — Capture selection resolves the latest
   *  command's output to a todo (§16.2). Callers decide when to pull; no polling is implied. */
  commands(): Promise<CommandSummary[]>;
  /** Mark-driven signal that a command span opened/closed (§15.5). */
  onCommandsChanged(cb: () => void): void;
  /** A command's output text, for adding straight to a todo (§16.2); null on unknown/trimmed id. */
  captureCommandText(commandId: string): Promise<CommandCaptureResult | null>;
  /** Run report-detection on demand and return the single latest report + findings (§21.1);
   *  [] when none. The captured report replaces any prior — the pane holds one (§21.1). */
  captureLast(): Promise<MonitorEvent[]>;
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
  // On-demand todo templates (§4.1/§6) — the picker lives in the todo widget (the monitor pane
  // talks only to window.monitor.*, §9.1), so these are monitor methods, not flow methods.
  /** Templates offered to the picker for the repo's active step (§4.1); empty when no step is
   *  active or the library is empty. `defaultRef` is the step's bound template. */
  listTemplates(repoKey: string): Promise<TodoTemplateList>;
  /** Instantiate the named template into the repo's todo list (§21.2), skipping items already
   *  present (silent dedup); resolves to the fresh list. */
  instantiateTemplate(repoKey: string, ref: string): Promise<TodoItem[]>;
}

/** Artifact viewer (§20): real, context-connected discovery + file read. Talks only to
 *  the main process (the widget never touches the fs directly), keeping it relocatable. */
export interface ViewerApi {
  /** Discover the current repo's artifact tree (§20.1); outside a repo, the whole cwd tree. */
  tree(scope: ArtifactScope): Promise<ArtifactTree>;
  /** Read one file by its tree-relative path; null when missing, binary, or too large. */
  read(relPath: string): Promise<ViewerFile | null>;
}

/** Flow lifecycle (§24.2.2): drive the manual step's status strip + control. Each call
 *  resolves to the resulting state so the strip re-renders from the response. */
export interface FlowApi {
  state(repoKey: string): Promise<FlowStateView>;
  /** not_started → in_progress; rejects if not currently not_started. */
  start(repoKey: string): Promise<FlowStateView>;
  /** in_progress → done; rejects if not currently in_progress. */
  advance(repoKey: string): Promise<FlowStateView>;
  /** done → in_progress; resets and re-runs the first step. Rejects if not currently done. */
  restart(repoKey: string): Promise<FlowStateView>;
}

declare global {
  interface Window {
    term: TermApi;
    monitor: MonitorApi;
    viewer: ViewerApi;
    flow: FlowApi;
  }
}
