// Typed IPC contract (§6) — single source of truth for channel names and payloads. Every payload
// carries sessionId so multi-session support is additive later.

import type { Chord, KeyActionId } from './keymap';

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
  monitorCleared: 'monitor:cleared',
  monitorLearnChrome: 'monitor:learnChrome',
  agentInject: 'agent:inject',
  uiGetSettings: 'ui:getSettings',
  uiSetSettings: 'ui:setSettings',
  clipboardWrite: 'term:clipboardWrite',
  clipboardRead: 'term:clipboardRead',
  menuEdit: 'menu:edit',
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
  viewerOnChanged: 'viewer:onChanged',
  flowState: 'flow:state',
  flowStart: 'flow:start',
  flowAdvance: 'flow:advance',
  flowRestart: 'flow:restart',
  flowUndo: 'flow:undo',
  flowTerminate: 'flow:terminate',
  flowProvideInput: 'flow:provideInput',
  flowOnStateChanged: 'flow:onStateChanged',
  flowRevealLoop: 'flow:revealLoop',
  flowBootstrapError: 'flow:onBootstrapError',
  flowBootstrapConflict: 'flow:onBootstrapConflict',
  flowResolveBootstrapConflict: 'flow:resolveBootstrapConflict',
  flowGithubRef: 'flow:githubRef',
  flowMarkTurnComplete: 'flow:markTurnComplete',
  flowGateDecision: 'flow:gateDecision',
  flowRetryTurn: 'flow:retryTurn',
  appOpenExternal: 'app:openExternal',
  todoTemplateList: 'todoTemplate:list',
  todoTemplateInstantiate: 'todoTemplate:instantiate',
  cliInstall: 'cli:install',
} as const;

/** Action-window tabs (§16.1). */
export type TabId = 'capture' | 'todo';

export type Theme = 'light' | 'dark';

/** The user's keymap profile choice (§7.7): `auto` resolves to `mac` on macOS else `pc`; `mac`/`pc`
 *  force that profile regardless of OS (e.g. a Mac keyboard on Linux). */
export type KeymapProfileSetting = 'auto' | 'mac' | 'pc';

/**
 * Global UI preferences (§16.6) — app-wide state persisted to userData, carrying no sessionId
 * (deliberate §16.6 exception to the §6 "every payload carries sessionId" rule). `splitRatio` is
 * the terminal pane's width fraction.
 */
export interface UiSettings {
  splitRatio: number;
  lastTab: TabId;
  theme: Theme;
  /** Artifact viewer tree-pane width in px (§20.2). */
  artifactTreeWidth: number;
  /** Full-screen tree-popout width in px (§20.2); absent until set — default is 30% of the viewport. */
  artifactFullscreenTreeWidth?: number;
  /** Keyboard layout profile (§7.7); `auto` follows the OS. */
  keymapProfile: KeymapProfileSetting;
  /** Per-action chord overrides merged over the profile (§7.7); absent when none are set. */
  keymapOverrides?: Partial<Record<KeyActionId, Chord[]>>;
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  splitRatio: 0.65,
  lastTab: 'capture',
  theme: 'light',
  artifactTreeWidth: 248,
  keymapProfile: 'auto',
};

export interface UiSetSettingsMsg {
  settings: Partial<UiSettings>;
}

/** Copy payload (§7.7): clipboard is an OS resource owned by main, so the renderer routes through it.
 *  App-global like UiSettings — no sessionId. */
export interface ClipboardWriteMsg {
  text: string;
}

/** The three clipboard editing actions the macOS Edit menu routes to the renderer (§7.7). */
export type EditAction = 'copy' | 'paste' | 'selectAll';

/** menu:edit broadcast (§7.7): a macOS Edit-menu item fired; the renderer routes by focus. */
export interface MenuEditMsg {
  action: EditAction;
}

// ---- Todo lists (§16.3 / §16.4) ----

// Tri-state lifecycle (§16.3): `active` and `in_progress` are both "outstanding" — they count and
// keep their row actions; only `done` is complete.
export type TodoStatus = 'active' | 'in_progress' | 'done';

export type TodoSourceType = 'manual' | 'selection' | 'report' | 'finding' | 'capture' | 'command-output';

export interface TodoSource {
  type: TodoSourceType;
  /** The source MonitorEvent id, when added from a capture (§16.2). */
  eventId?: string;
}

/**
 * A persistent, repo-scoped todo (§16.3). `order` is the sort key within a status group (active
 * list / Done section).
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
 * Typed semantic/command regions plus the manual `capture` (§15.4 / v2.6). `report` is an agent
 * report group; `finding` is one individually-actionable item inside it (linked via `parentId`).
 * `completion` is reserved/unused — permission/question detection was removed in v2.6.
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

/** monitor:cleared broadcast (#26): main cleared the global capture/event store as part of a flow
 *  Terminate; the monitor pane drops every rendered capture so the capture tab reflects the empty
 *  store. Payload-free beyond the session (the store is a single global list, not repo-scoped). */
export interface MonitorClearedMsg {
  sessionId: SessionId;
}

export interface MonitorEventMsg {
  sessionId: SessionId;
  event: MonitorEvent;
}

/**
 * A previously-emitted semantic event was retracted because a later capture supersedes it (§15.3).
 * The pane drops the block; removing a `report` drops its nested findings with it.
 */
export interface MonitorEventRemovedMsg {
  sessionId: SessionId;
  eventId: string;
}

/**
 * Mark a captured block as chrome (§15.x): main learns its leading glyphs as chrome markers (so
 * future furniture led by them is filtered) and retracts this capture. `sample` is the block's text.
 */
export interface MonitorLearnChromeMsg {
  sessionId: SessionId;
  eventId: string;
  sample: string;
}

/** The agent's repo key changed (OSC 7 → §16.3); the action window re-pulls its todo list. */
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
  'monitor:cleared': MonitorClearedMsg;
  'monitor:commandsChanged': CommandsChangedMsg;
  'cwd:changed': CwdChangedMsg;
  'viewer:onChanged': ViewerChangedMsg;
  'flow:onStateChanged': FlowStateChangedMsg;
  'menu:edit': MenuEditMsg;
  'flow:revealLoop': FlowRevealLoopMsg;
  'flow:onBootstrapError': FlowBootstrapErrorMsg;
  'flow:onBootstrapConflict': FlowBootstrapConflictMsg;
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

/** viewer:onChanged broadcast (§20.1): main signals that a file under the viewer's tree root changed
 *  on disk; the viewer re-pulls `viewer:tree`/`viewer:read`. Payload-free beyond the session — the
 *  viewer re-discovers against its own live cwd, mirroring flow:onStateChanged. */
export interface ViewerChangedMsg {
  sessionId: SessionId;
}

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
  /** 1-based current-file lines added/modified vs the PR base (else HEAD; code files in a repo; §20.2). Absent when none. */
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

/** The live, derived status of an in-progress step (§22.3 / §24.2.2 S5): a pure function of the
 *  flow state, the repo's todo list, and the §8.3 agent activity. `ready` (every todo is done) is
 *  the gate-readiness signal. Present only while `status === 'in_progress'`. */
export interface FlowDerived {
  activity: AgentState;
  todosDone: number;
  todosTotal: number;
  ready: boolean;
}

/** The read-only mirror of a loop step's agent-loop v4 state.yaml (§24.2.3 T2): the live engine
 *  vocabulary the app surfaces. `status` is the per-LoopDef state-machine string (unbounded — the
 *  strip maps it onto a generic 3-tone pill, never an enum); `pr`/`branch` are null before the loop
 *  has a PR. `ready` is the §19.2 advance gate — gate-driven when the bound LoopDef resolves (true
 *  only at a TERMINAL gate, the loop's exit), else the documented awaiting-human-* family. */
export interface FlowLoopView {
  status: string;
  iteration: number;
  pr: number | null;
  branch: string | null;
  ready: boolean;
  /** The current status's gate `human_options` (§18.1/§19.4) — the gate UI's variable option set
   *  (`approve`/`request-changes`/`impasse`). Present only at an awaiting gate with a resolvable
   *  LoopDef; absent mid-work, at a terminal gate, or when the LoopDef does not resolve. */
  gateOptions?: string[];
  /** The §26.10 cost-meter readout: the display-only priced dollars for the run (`$X.XX`, `unknown`, or
   *  `$X.XX +unknown` when some model was unpriced), formatted by the shared `formatCost`. Present once an
   *  iteration boundary has recorded a cost; absent before then. Display-only — it never gates the loop. */
  cost?: string;
  /** Observable "the loop is blocked awaiting a human" classification (§24.2.3 T4): true at a
   *  LoopDef human-decision gate (or, with no resolvable LoopDef, the shared awaiting-human/impasse
   *  family), false at a terminal hand-off or mid-work. Computed by main (where the LoopDef
   *  resolves); the renderer reads it rather than re-deriving the gate/awaiting logic. Always set on
   *  a derived loop view — the `?` is for hand-constructed views only. */
  humanNeeded?: boolean;
  /** §26.3/D48 — the reason the current turn failed, present only at `status: 'error'`. Lets the loop
   *  panel show WHY the loop stopped (e.g. "no Claude at the prompt") rather than a bare "error", and is
   *  cleared the moment the status recovers. Absent on every non-error view. */
  errorReason?: string;
}

/** The GitHub issue (ticket) and PR a flow is working (§24.2.3 T7). Numbers only — the title, body,
 *  and url are fetched lazily via `flow:githubRef` so `flow:state` stays synchronous and best-effort.
 *  `ticket` is the value of the flow's `github-ticket`-typed input, falling back to the loop's
 *  `linked_issues`; `pr` is the value of the flow's `pr`-typed input, falling back to the loop's
 *  state.yaml `pr`. Either may be absent; the whole field is absent when neither resolves. Visibility is
 *  gated on flow progress (§24.2.3 T7): a typed-input ref surfaces only once a step requesting that
 *  input is entered, and the loop's `linked_issues`/`pr` only once a loop step is entered. */
export interface FlowRefs {
  ticket?: number;
  pr?: number;
}

/** Whether a refs payload actually carries a number to show. The one definition both processes share
 *  (CLAUDE.md shared-semantics): main emits `undefined` for an empty refs object, and every renderer
 *  consumer (strip read-out, docked panel, composition root) gates on this same predicate, so they
 *  cannot drift on what counts as renderable refs. */
export function hasFlowRefs(refs: FlowRefs | undefined): refs is FlowRefs {
  return refs !== undefined && (refs.ticket !== undefined || refs.pr !== undefined);
}

/** Which kind of GitHub ref to resolve (§24.2.3 T7): a `ticket` is an issue, `pr` a pull request. */
export type GithubRefKind = 'issue' | 'pr';

/** The fetched GitHub ref detail (§24.2.3 T7): the title + description body the popout shows and the
 *  canonical `url` the link opens. Resolved best-effort via `gh`; the whole result is null when it
 *  can't be resolved (no `gh`, not a GitHub repo, offline), so the popout shows the number alone. */
export interface GithubRef {
  title: string;
  body: string;
  url: string;
}

/** One typed input the renderer's modal must collect (§18.4 / §24.2.3 T3): the field `name` and its
 *  catalog `type` (`github-ticket`/`pr`/`files`/`free-text`), which labels and shapes the picker. */
export interface FlowInputSpec {
  name: string;
  type: string;
}

/** A step-entry prompt for unsatisfied required inputs (§18.4 / §24.2.3 T3): carried on a transition
 *  view when entering a step whose `bootstrap` needs an input that isn't resolved yet. `inputs` are
 *  the fields to collect; `bootstrap` names the command they feed (e.g. `agent-loop pickup`) for the
 *  modal's helper text. The renderer opens its modal, collects values, and calls `flow:provideInput`. */
export interface FlowPrompt {
  inputs: FlowInputSpec[];
  bootstrap: string;
}

/** The flow's live view (§22.3 status strip): the current step's name, its 1-based
 *  `position` within `total` steps, and its `status`. S2 sources the step from
 *  `<worktree>/.agent-terminal/flow.yaml` (§18.1); on a load failure `status` is
 *  `error` and `error` carries the human-readable reason (position/total 0). */
export interface FlowStateView {
  stepName: string;
  /** Every step's name, in flow order (§24.2.3 T1) — the §22.3 rail renders one station per entry;
   *  `stepName` is `steps[position - 1]`. Empty on an `error` view (no steps to show). */
  steps: string[];
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
  /** Live derived status (§22.3 / §24.2.2 S5): agent activity + todo completion + gate readiness.
   *  Present only on an `in_progress` view (computed by main from the repo's todos + §8.3 activity). */
  derived?: FlowDerived;
  /** Read-only agent-loop state.yaml mirror (§24.2.3 T2): present once a `loop` step has been entered
   *  (and stays for the run, including any later manual step) with a parseable v4 state.yaml. Parallel
   *  to `derived` (NOT nested) — loop state outlives the manual in_progress window that gates `derived`. */
  loop?: FlowLoopView;
  /** The ticket + PR the flow is working (§24.2.3 T7): numbers resolved synchronously from the flow
   *  inputs and the loop's state.yaml, gated on flow progress (see `FlowRefs`). The renderer fetches each
   *  one's title/body/url lazily via `flow:githubRef`. */
  refs?: FlowRefs;
  /** A one-shot step-entry input prompt (§18.4 / §24.2.3 T3): present on a `start`/`restart`/`advance`
   *  response when the entered step's `bootstrap` needs an unsatisfied required input. The renderer
   *  opens its modal and answers via `flow:provideInput`. Like `notice`, never part of `state()`. */
  prompt?: FlowPrompt;
}

/** flow:onStateChanged broadcast (§24.2.2 S5): main signals that a flow-relevant input changed
 *  (a todo mutated, the agent flipped active/quiet); the strip re-pulls `flow:state`. Carries no
 *  payload beyond the session — the strip re-pulls for its own current repoKey (§16.3). */
export interface FlowStateChangedMsg {
  sessionId: SessionId;
}

/** flow:revealLoop push (§24.2.3 T4): main signals that the OS attention notification was activated
 *  and the loop read-out must be revealed. The renderer responds by exiting viewer-fullscreen if
 *  active, switching to the Terminal view, and opening the docked loop read-out. Window focus is a
 *  main-side effect; carries no payload beyond the session. */
export interface FlowRevealLoopMsg {
  sessionId: SessionId;
}

/** flow:onBootstrapError push (§26.9): main signals that a loop step's async in-app pickup FAILED and the
 *  flow was rolled back to the previous step (revertStep). The failure is never silent — the renderer
 *  raises a blocking error dialog carrying `reason` (the human-readable cause: dirty tree, unresolvable
 *  base, conflicting branch). Distinct from the transient strip `notice`: an async failure has no
 *  transition response to ride, so it needs its own push. */
export interface FlowBootstrapErrorMsg {
  sessionId: SessionId;
  reason: string;
}

/** flow:onBootstrapConflict push (§26.9): main signals that an in-app pickup hit an EXISTING branch/PR
 *  under a `wipe-and-retry` policy. Nothing destructive has been done — the flow stays on the loop step
 *  and the renderer raises a confirm dialog offering to wipe `branch` (which deletes it on origin and
 *  closes its PR) and retry. The operator's answer returns on `flow:resolveBootstrapConflict`. */
export interface FlowBootstrapConflictMsg {
  sessionId: SessionId;
  branch: string;
}

/** flow:resolveBootstrapConflict request (§26.9): the operator's answer to a bootstrap conflict. `wipe`
 *  true → the app wipes the conflicting branch and re-runs pickup; false (Cancel/dismiss) → the app rolls
 *  the flow back one step (the §26.9 rollback). One-way; the result surfaces through the state.yaml watch
 *  → flow:onStateChanged (on wipe success) or a rolled-back flow:state re-pull (on cancel). */
export interface FlowResolveBootstrapConflictMsg {
  sessionId: SessionId;
  repoKey: string;
  wipe: boolean;
}

/** flow:state/start/advance/restart request. `repoKey` scopes the flow to the terminal's current
 *  repo (§16.3), threaded like the todo channels so the flow follows the cwd (§6). */
export interface FlowRequestMsg {
  sessionId: SessionId;
  repoKey: string;
}

/** flow:provideInput request (§18.4 / §24.2.3 T3): the renderer's answer to a step-entry `prompt`.
 *  `values` maps each prompted input name to the user's typed value; main persists them to flow-state
 *  and re-runs the entry bootstrap (`agent-loop pickup <input>`) now that the input is resolved. */
export interface FlowProvideInputMsg {
  sessionId: SessionId;
  repoKey: string;
  values: Record<string, string>;
}

/** flow:markTurnComplete request (§26.3/D47a c): the operator's manual "this turn is done" override
 *  for the in-flight loop turn whose automatic done-signal the orchestrator missed. One-way; the
 *  result surfaces through the existing state.yaml watch → flow:onStateChanged push. */
export interface FlowMarkTurnCompleteMsg {
  sessionId: SessionId;
  repoKey: string;
}

/** The human's gate decision (§26.6 / L5): the option picked at a data-driven awaiting-human gate. The
 *  set mirrors the LoopDef `human_options` the gate offers. One runtime source (`GATE_DECISION_OPTIONS`)
 *  drives both the type and the §6 validator, so main, renderer, and the wire cannot drift on the set. */
export const GATE_DECISION_OPTIONS = ['approve', 'request-changes', 'impasse'] as const;
export type GateDecisionOption = (typeof GATE_DECISION_OPTIONS)[number];

/** flow:gateDecision request (§26.6 / L5): the human picks an option at an awaiting-human gate. The app
 *  executes that option's LoopDef `on_*` action list in-app (gh side-effects out of band) and advances /
 *  re-iterates / stops. One-way; the result surfaces through the state.yaml watch → flow:onStateChanged
 *  push. `note` carries an optional request-changes/impasse reason (written to human-notes/{iter}.md). */
export interface FlowGateDecisionMsg {
  sessionId: SessionId;
  repoKey: string;
  option: GateDecisionOption;
  note?: string;
}

/** flow:githubRef request (§24.2.3 T7): resolve a ref's title/body/url for the popout. `repoKey`
 *  scopes the `gh` lookup to the right repo; `number` is the issue/PR number; `kind` selects which. */
export interface FlowGithubRefMsg {
  sessionId: SessionId;
  repoKey: string;
  kind: GithubRefKind;
  number: number;
}

/** app:openExternal request (§24.2.3 T7): open a ref's GitHub `url` in the OS browser. Main validates
 *  the url (https + a GitHub host) before handing it to the OS — the renderer cannot open arbitrary
 *  schemes (CWE-601 open-redirect / local-scheme abuse). */
export interface AppOpenExternalMsg {
  sessionId: SessionId;
  url: string;
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

// ---- CLI launcher install (§23.4 / #25) ----

/** cli:install request (§6): install the `agent-terminal` launch shim onto the user's PATH. Carries
 *  sessionId per §6; no other payload — the install target is computed by main from the running build. */
export interface CliInstallMsg {
  sessionId: SessionId;
}

/** cli:install result: `ok` with the installed command `path`, or `!ok` with a human-readable `error`.
 *  Never a partial state — `ok` is true only when the command is runnable from a new shell. */
export type CliInstallResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

// ---- Preload-exposed API surfaces (§6) ----

/** Host OS, exposed to the renderer so it can resolve the `auto` keymap profile (§7.7). */
export type OsPlatform = 'darwin' | 'win32' | 'linux';

export interface TermApi {
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (msg: PtyExitMsg) => void): () => void;
  input(data: string): void;
  resize(size: { cols: number; rows: number }): void;
  /** Write text to the OS clipboard — backs the Copy action (§7.7). */
  clipboardWrite(text: string): void;
  /** Read text from the OS clipboard — backs the Paste action (§7.7). */
  clipboardRead(): Promise<string>;
  /** The host OS, for resolving the `auto` keymap profile in the renderer (§7.7). */
  platform: OsPlatform;
  /** Subscribe to macOS Edit-menu actions (§7.7); the renderer routes them by focus. */
  onMenuAction(cb: (action: EditAction) => void): () => void;
  /** Absolute filesystem path of a dropped `File` (§7.8) — `File.path` is gone under contextIsolation,
   *  so the renderer routes through the preload's `webUtils`. Returns `''` for a non-file drag item. */
  pathForFile(file: File): string;
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
  /** main cleared the global capture/event store (e.g. a flow Terminate, #26); drop every rendered
   *  capture so the capture tab reflects the empty store. */
  onCleared(cb: () => void): void;
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
  /** Subscribe to main's viewer:onChanged push (§20.1): `cb` fires when a file under the viewer's
   *  tree root changes on disk, prompting a `tree()`/`read()` re-pull. Returns an unsubscribe. */
  onChanged(cb: () => void): () => void;
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
  /** done → in_progress; reverts a manual advance WITHOUT re-running the step's entry actions
   *  (unlike restart). Rejects if not currently done. */
  undo(repoKey: string): Promise<FlowStateView>;
  /** in_progress|done → not_started (#26): abandons the flow, discarding carried-over inputs, and
   *  resolves to the reset (not_started) view. Inert from not_started / load-error. Main also clears
   *  the repo's todos, the global capture tab, and finalizes the audit run as one user-confirmed action. */
  terminate(repoKey: string): Promise<FlowStateView>;
  /** Answer a step-entry input `prompt` (§18.4 / §24.2.3 T3): persist the typed `values` to
   *  flow-state and re-run the entry bootstrap (`agent-loop pickup <input>`), returning the new
   *  view (its `notice` carries any §19.3 busy refusal). */
  provideInput(repoKey: string, values: Record<string, string>): Promise<FlowStateView>;
  /** Subscribe to main's flow:onStateChanged push (§24.2.2 S5): `cb` fires when a flow-relevant
   *  input changed (todo/activity), prompting a `state()` re-pull. Returns an unsubscribe. */
  onStateChanged(cb: () => void): () => void;
  /** Subscribe to main's flow:revealLoop push (§24.2.3 T4): `cb` fires when the OS attention
   *  notification was activated and the loop read-out must be revealed. Returns an unsubscribe. */
  onRevealLoop(cb: () => void): () => void;
  /** Subscribe to main's flow:onBootstrapError push (§26.9): `cb` fires with the human-readable `reason`
   *  when a loop step's async pickup failed and the flow was rolled back; the renderer raises a blocking
   *  error dialog. Returns an unsubscribe. */
  onBootstrapError(cb: (reason: string) => void): () => void;
  /** Subscribe to main's flow:onBootstrapConflict push (§26.9): `cb` fires with the conflicting `branch`
   *  when a pickup hit an existing branch under a wipe-and-retry policy; the renderer raises a confirm
   *  dialog and answers via `resolveBootstrapConflict`. Returns an unsubscribe. */
  onBootstrapConflict(cb: (branch: string) => void): () => void;
  /** Answer a bootstrap conflict (§26.9): `wipe` true wipes the branch + retries, false rolls the flow
   *  back. One-way; the result surfaces through the state.yaml watch / a rolled-back state re-pull. */
  resolveBootstrapConflict(repoKey: string, wipe: boolean): void;
  /** Resolve a GitHub ref's title/body/url for the popout (§24.2.3 T7), best-effort: null when it
   *  can't be resolved (no `gh`, not a GitHub repo, offline) so the popout shows the number alone. */
  githubRef(repoKey: string, kind: GithubRefKind, number: number): Promise<GithubRef | null>;
  /** Open a ref's GitHub `url` in the OS browser (§24.2.3 T7); resolves to whether it was opened
   *  (false when main rejects the url as non-GitHub/non-https). */
  openExternal(url: string): Promise<boolean>;
  /** §26.3/D47a(c) — manually mark the in-flight loop turn complete for `repoKey`. One-way: the loop
   *  panel re-pulls via flow:onStateChanged when the orchestrator's resulting state lands. */
  markTurnComplete(repoKey: string): void;
  /** §26.6 / L5 — submit the human's gate decision for `repoKey`. One-way: the app executes the option's
   *  transition and the loop panel re-pulls via flow:onStateChanged when the resulting state lands. */
  gateDecision(repoKey: string, option: GateDecisionOption, note?: string): void;
  /** §26.3/D48 — recover a loop stopped in `error` for `repoKey`: re-drive the failed turn (e.g. after the
   *  operator starts Claude for a `no hosted agent` stop). One-way: the app clears the error status and
   *  re-injects; the loop panel re-pulls via flow:onStateChanged when the resulting state lands. */
  retryTurn(repoKey: string): void;
}

/** CLI launcher install (§23.4 / #25): the settings affordance's only seam to the install action. */
export interface CliApi {
  /** Install the `agent-terminal` launch shim onto PATH, reconciling to the running build. */
  install(): Promise<CliInstallResult>;
}

declare global {
  interface Window {
    term: TermApi;
    monitor: MonitorApi;
    viewer: ViewerApi;
    flow: FlowApi;
    cli: CliApi;
  }
}
