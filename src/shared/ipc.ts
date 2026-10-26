// Typed IPC contract (§6) — single source of truth for channel names and payloads. Every payload
// carries sessionId so multi-session support is additive later.

import type { RunIdentity } from './runIdentity';
import type { Chord, KeyActionId } from './keymap';
import type { LoopActivity } from './loopActivity';
import type { ConsolidatorVerdict } from './consolidatorOutput';
import type { AppBootstrapConflictTarget } from './appBootstrap';
import type { StartednessSignal } from './flowStarted';
import type { HeldRunView } from './runHold';
import type { AutoHaltReason, FailedEffectState } from './gateAuthority';

export type SessionId = string;

/** The single fixed session id in this version (§6). */
export const SESSION_ID: SessionId = 's1';

export const CH = {
  ptyData: 'pty:data',
  ptyInput: 'pty:input',
  ptyResize: 'pty:resize',
  ptyExit: 'pty:exit',
  startupReady: 'startup:ready',
  startupRendered: 'startup:rendered',
  startupIncompatible: 'startup:incompatible',
  monitorCapture: 'monitor:capture',
  monitorEvent: 'monitor:event',
  monitorEventRemoved: 'monitor:eventRemoved',
  monitorUpdate: 'monitor:update',
  monitorReplay: 'monitor:replay',
  monitorCurrentRepo: 'monitor:currentRepo',
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
  flowSetTitle: 'flow:setTitle',
  flowSetActiveFlow: 'flow:setActiveFlow',
  flowClearActiveFlow: 'flow:clearActiveFlow',
  flowListCatalog: 'flow:listCatalog',
  flowRebindHeldRun: 'flow:rebindHeldRun',
  flowConfirmRunPickup: 'flow:confirmRunPickup',
  flowOnStateChanged: 'flow:onStateChanged',
  flowRevealLoop: 'flow:revealLoop',
  flowOnBootstrapError: 'flow:onBootstrapError',
  flowOnLoopError: 'flow:onLoopError',
  flowOnAppBootstrapConflict: 'flow:onAppBootstrapConflict',
  flowResolveAppBootstrapConflict: 'flow:resolveAppBootstrapConflict',
  flowOnEpicPromotionPreview: 'flow:onEpicPromotionPreview',
  flowResolveEpicPromotion: 'flow:resolveEpicPromotion',
  flowGithubRef: 'flow:githubRef',
  flowAppRouteOut: 'flow:appRouteOut',
  flowAppGateDecision: 'flow:appGateDecision',
  flowAppRequestChanges: 'flow:appRequestChanges',
  flowAppRedo: 'flow:appRedo',
  flowAppBackToRed: 'flow:appBackToRed',
  flowArmInterrupt: 'flow:armInterrupt',
  appOpenExternal: 'app:openExternal',
  todoTemplateList: 'todoTemplate:list',
  todoTemplateInstantiate: 'todoTemplate:instantiate',
  cliInstall: 'cli:install',
  installExamplesPreview: 'examples:preview',
  installExamplesApply: 'examples:apply',
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
 * Typed semantic/command regions plus the manual `capture` (§15.4). `report` is an agent
 * report group; `finding` is one individually-actionable item inside it (linked via `parentId`).
 * `completion` is reserved/unused — permission/question detection was removed.
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
  /** A `finding`'s parent `report` id; null for top-level events (§15.4). */
  parentId: string | null;
  /** True when scrollback trim lost part of the region before extraction (§15.2). */
  truncated: boolean;
  capturedAt: string;
}

/** "Capture last report" (§21.1): run report-detection on demand; resolves to the single
 *  latest report + findings (replacing the prior capture), or [] when none is detected. */
export interface CaptureLastMsg {
  sessionId: SessionId;
}

/** Dismiss a captured event; dismissing a `report` cascades to its findings (§15.6). */
export interface DismissMsg {
  sessionId: SessionId;
  eventId: string;
}

/** Dismiss every captured event in the pane (§15.6). */
export interface DismissAllMsg {
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
  'cwd:changed': CwdChangedMsg;
  'viewer:onChanged': ViewerChangedMsg;
  'flow:onStateChanged': FlowStateChangedMsg;
  'menu:edit': MenuEditMsg;
  'flow:revealLoop': FlowRevealLoopMsg;
  'flow:onBootstrapError': FlowBootstrapErrorMsg;
  'flow:onLoopError': FlowLoopErrorMsg;
  'flow:onAppBootstrapConflict': FlowAppBootstrapConflictMsg;
  'flow:onEpicPromotionPreview': FlowEpicPromotionPreviewMsg;
}

export type SendChannel = keyof ChannelPayloads;

// ---- Artifact viewer (§20.1/§20.2) ----

/** Per-file provenance tags (D8): tracked-but-changed in the working tree, under the
 *  §27 loop tree (`.agent-terminal/loop/`), or part of the current PR. Empty/omitted when none apply. */
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

/** §27.9.1 */
export interface FlowAutoGateView {
  deciding: boolean;
  hung: boolean;
  haltReasons: { reason: AutoHaltReason; detail?: string }[];
  failedEffect?: { state: FailedEffectState; detail: string };
}

/** The §27 loop view (§24.2.3 T2 / §27.15): the engine-neutral vocabulary the loop panel and strip
 *  render, produced by the bound engine — not a mirror of any file the app reads.
 *  `status` is the per-LoopDef state-machine string (unbounded — the
 *  strip maps it onto a generic 3-tone pill, never an enum); `pr`/`branch` are null before the loop
 *  has a PR. `ready` is the §19.2 advance gate — gate-driven when the bound LoopDef resolves (true
 *  only at a TERMINAL gate, the loop's exit), else the documented awaiting-human-* family. */
export interface FlowLoopView {
  status: string;
  /** The run's iteration counter (§27.5). Absent means NO ROUND HAS RUN — the honest value for a
   *  §27 def that resolved before any round (a run-less view) and for a def that failed to resolve;
   *  a coalesce-to-zero would fabricate a round identity the dedup key and the audit both key on. Every
   *  consumer (panel, strip, dedup) omits its iteration read-out when absent rather than showing 0. */
  iteration?: number;
  pr: number | null;
  branch: string | null;
  ready: boolean;
  /** Whether this view's `gateOptions` are ACTIONABLE — the human can click them to decide the gate.
   *  Read through the shared `loopGateActionable`, whose default governs: a producer marks a view
   *  display-only by opting in — the §27 run-less view sets `actionable: false` — and anything that does not
   *  opt in is actionable, so every hand-constructed awaiting-gate view keeps its controls and the same
   *  `gateOptions` field never means two things. The default lives once, in `loopGateActionable`. */
  actionable?: boolean;
  /** The current status's gate `human_options` (§18.1/§19.4) — the gate UI's variable option set
   *  (`approve`/`request-changes`/`impasse`), OR the options a §27 def declares for a run-less view.
   *  The producing engine owns when to fill it; `actionable` carries whether they are clickable. */
  gateOptions?: string[];
  /** Observable "the loop is blocked awaiting a human" classification (§24.2.3 T4): true at a
   *  LoopDef human-decision gate (or, with no resolvable LoopDef, the shared awaiting-human/impasse
   *  family), false at a terminal hand-off or mid-work. Computed by main (where the LoopDef
   *  resolves); the renderer reads it rather than re-deriving the gate/awaiting logic. Always set on
   *  a derived loop view — the `?` is for hand-constructed views only. */
  humanNeeded?: boolean;
  autoGate?: FlowAutoGateView;
  /** §27.12 — the reason the current turn failed (or, on a marked binding, why the step names no surviving
   *  engine), present only at `status: 'error'`. Lets the loop panel show WHY the loop stopped (e.g. "no
   *  Claude at the prompt") rather than a bare "error", and is cleared the moment the status recovers.
   *  Absent on every non-error view. */
  errorReason?: string;
  /** §27.12 — the turn stopped on a stall after its prompt went in, so its own done-signal still completes it. */
  stalled?: boolean;
  /** §27.12/§27.15 — the identity of the §27 (app-namespace) work turn this view reflects: the flow step it
   *  runs against and its turn key. Present ONLY on a live §27 run view (working/error/complete); absent on
   *  the §27 run-less/def-failure view (no turn has started). The panel carries this onto the §27-only error
   *  route-out (retry / accept / terminate) so the receiver acts on the identity it names, never ambient
   *  state (§6). Additive and §27-only (§27.15). */
  appTurn?: { step: string; turnKey: string };
  /** §27.4/§27.6/AC8 — the def's reviewer catalog (every persona the loop can invoke) and, once the
   *  consolidator has chosen, `chosenRoster` (the personas the next/current round runs). Both are the SAME
   *  parsed-def data the round is drawn from, so the displayed roster and the round's actual roster cannot
   *  drift. Additive and §27-only. */
  catalog?: string[];
  chosenRoster?: string[];
  /** §27.6/AC5/AC9 — the round's consolidator verdict, the closed `ConsolidatorVerdict` set the engine and
   *  loop-state already carry, so a fourth value cannot cross the wire. Only under `stop for a human` does
   *  `verdictReason` accompany it. The panel surfaces the verdict at the gate, and the would-be verdict on an
   *  armed interrupt. Additive and §27-only. */
  verdict?: ConsolidatorVerdict;
  verdictReason?: string;
  /** §27.9/AC6/AC11 — the polish stand-down is active for this step: the orchestrator has stood down and the
   *  operator owns the keyboard, so the panel shows the polish view (only the approve control, which ends it)
   *  rather than the full gate options. App-owned loop state, persisted independently of the run-state so it
   *  survives a relaunch until the operator approves. Additive and §27-only. */
  polish?: boolean;
  /** §28.5.3/§28.8.3 — the test-glob files the machine detected changed during a GREEN turn, recorded under
   *  this run's step. A NON-blocking detect-and-escalate flag: the panel surfaces it for the regression-guard
   *  persona + the human gate. Absent when none changed (a clean GREEN records an empty flag, which does not
   *  show) or when the record is for another step. Additive and §27-only. */
  changedTests?: string[];
  /** §28.7 — the epic decomposition (src/shared/epicPlan.ts) surfaced at the gate for an epic-capable loop; the
   *  operator judges the split before approving (§27.10). Absent otherwise. Additive and §27-only. */
  epic?: { subTickets: { index: number; title: string }[] };
}

/** The GitHub issue (ticket) and PR a flow is working (§24.2.3 T7). Numbers only — the title, body,
 *  and url are fetched lazily via `flow:githubRef` so `flow:state` stays synchronous and best-effort.
 *  `ticket` is the value of the flow's `github-ticket`-typed input; `pr` is the value of the flow's
 *  `pr`-typed input. Either may be absent; the whole field is absent when neither resolves. Visibility is
 *  gated on flow progress (§24.2.3 T7): a typed-input ref surfaces only once a step requesting that input
 *  is entered. */
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
  /** A one-shot transient notice — the §19.3 running-process refusal when a skill couldn't be injected
   *  over a busy shell, or AC 5's migration notice (§24.2.2 S4). Carried on a transition response, or on a
   *  `state` response when an asynchronous producer (the bootstrap coordinator) has one pending; the strip
   *  holds it across passive re-pulls and clears it on the next transition. */
  notice?: string;
  /** The active step's bound `todo_template:` ref (§18.6), when it declares one — the default the
   *  on-demand todo-template picker offers while the step is active (§6/§4.1). */
  templateRef?: string;
  /** Live derived status (§22.3 / §24.2.2 S5): agent activity + todo completion + gate readiness.
   *  Present only on an `in_progress` view (computed by main from the repo's todos + §8.3 activity). */
  derived?: FlowDerived;
  /** What the loop MECHANICS are doing right now: the surviving `bootstrapping` phrase (§27.10). The
   *  descriptor's PRESENCE is "the loop is busy"; there is no idle descriptor. Top-level (NOT under `loop`)
   *  because a bootstrap runs before the §27 run state exists; absent when the loop mechanics are idle. */
  loopActivity?: LoopActivity;
  /** The §27 loop view (§27.15): present once a `loop` step has been entered (and stays for the run,
   *  including any later manual step), produced by the §27 provider — not a mirror of any file the app
   *  reads. Parallel to `derived` (NOT nested) — loop state outlives the manual in_progress window. */
  loop?: FlowLoopView;
  /** The ticket + PR the flow is working (§24.2.3 T7): numbers resolved synchronously from the flow's
   *  typed inputs, gated on flow progress (see `FlowRefs`). The renderer fetches each one's title/body/url
   *  lazily via `flow:githubRef`. */
  refs?: FlowRefs;
  /** The name the user gave this worktree's work (§22.3.1), persisted in flow-state.yaml. The status bar
   *  shows it only when neither a PR nor a ticket supplies a title (`deriveStatusBar`) — it is outranked,
   *  never discarded, so it returns if the refs go away. Absent when the user has named nothing. */
  userTitle?: string;
  /** A one-shot step-entry input prompt (§18.4 / §24.2.3 T3): present on a `start`/`restart`/`advance`
   *  response when the entered step's `bootstrap` needs an unsatisfied required input. The renderer opens
   *  its modal and answers via `flow:provideInput`. Transition-driven — never part of `state()`. */
  prompt?: FlowPrompt;
  /** §18.7.4 — the RAW durable run started-ness, distinct from (and never) the load-maskable `status`: a reset
   *  whose run record could not be removed shows `status: 'not_started'` while the run stays `'started'`.
   *  Classify it only through `isSelectionLocked` (shared/flowStarted.ts). */
  runStarted: StartednessSignal;
  /** §18.7.3 */
  runHold?: HeldRunView;
  /** §27.13 — present while the run is held for the operator to confirm its ticket and pull request. */
  pickupConfirm?: PickupConfirmView;
}


/** §27.13 */
export type PickupConfirmView =
  | { run: RunIdentity; state: 'looking' }
  | { run: RunIdentity; state: 'proposed'; branch: string | null; pr: number | null; ticket: number | null; problems: string[] };

/** §6 — the run is named so a confirm can only release the hold the operator was shown. */
export interface FlowConfirmRunPickupMsg {
  sessionId: SessionId;
  repoKey: string;
  run: RunIdentity;
  pr: number;
  ticket: number;
}

export type ConfirmRunPickupResult = { ok: true } | { ok: false; reason: string };

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

/** flow:onBootstrapError push (§27.10): main signals that a loop step's bootstrap could not proceed — an
 *  async in-app pickup that failed and rolled back to the previous step (revertStep), OR (AC 10) a declared
 *  `bootstrap` the bound def carries no contract for. The failure is never silent — the renderer raises a
 *  blocking error dialog carrying `reason` (the human-readable cause). `repoKey` and `step` name the failed
 *  resource, so a late push cannot be attributed to ambient flow state. */
export interface FlowBootstrapErrorMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  reason: string;
}

/** The severity a flow:onLoopError message carries: a genuine `error` (the default — a failed loop
 *  mechanic, framed as a blocking error dialog) or a non-blocking `notice` the operator should see but which
 *  must not raise a blocking dialog — a benign completed no-op (§28.3 nothing-to-commit) or a best-effort
 *  degradation that left the accept intact (§28.5.1 baseline-record-failed). One definition the main writer and
 *  the renderer both key on (CLAUDE.md shared-vocabulary). */
export type FlowLoopMessageKind = 'error' | 'notice';

/** flow:onLoopError push (§27.12/§28.3): main signals a loop-MECHANICS outcome after the loop was
 *  bootstrapped. `kind: 'error'` (default) is a FAILURE — a turn-runner error (no hosted agent, a stall, a
 *  missing artifact, a compose failure) or an un-persistable gate transition; the renderer raises a blocking
 *  error dialog carrying `reason`. `kind: 'notice'` is a benign completed no-op (§28.3 nothing-to-commit),
 *  surfaced on the same channel but framed as a notice, not a failure. Distinct channel from
 *  `flow:onBootstrapError` so pickup-time and run-time messages keep their own dialog titles. */
export interface FlowLoopErrorMsg {
  sessionId: SessionId;
  reason: string;
  kind?: FlowLoopMessageKind;
}

/** §6/§27.10. */
export interface FlowAppBootstrapConflictMsg extends AppBootstrapConflictTarget {
  sessionId: SessionId;
  repoKey: string;
  step: string;
}

/** §6/§27.10. */
export interface FlowResolveAppBootstrapConflictMsg
  extends AppBootstrapConflictTarget {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  wipe: boolean;
}

/** §6/§28.7 — the confirm-first preview naming every GitHub mutation the operator authorizes by confirming:
 *  the sub-tickets promotion will create, plus the epic tracking-issue edit and the epic PR close. `epic`/`pr`
 *  are the resource identities the renderer names (never re-derived — §6). */
export interface FlowEpicPromotionPreviewMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  epic: number;
  pr: number | null;
  subTickets: { index: number; title: string }[];
}

/** §6/§28.7 — the operator's answer to the confirm-first preview: `confirm` runs the promotion, otherwise it
 *  is declined and the gate is left as it was. */
export interface FlowResolveEpicPromotionMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  confirm: boolean;
}

/** flow:state/start/advance/restart request. `repoKey` scopes the flow to the terminal's current
 *  repo (§16.3), threaded like the todo channels so the flow follows the cwd (§6). */
export interface FlowRequestMsg {
  sessionId: SessionId;
  repoKey: string;
}

/** flow:advance request: `step` is the step the strip showed (§27.9.1 N9b.5(e)); optional. */
export interface FlowAdvanceMsg extends FlowRequestMsg {
  step?: string;
}

/** flow:provideInput request (§18.4 / §24.2.3 T3 / §27.10): the renderer's answer to a step-entry
 *  `prompt`. `step` is the identity the prompt was raised for; a stale answer is inert rather than being
 *  applied to the flow's ambient current step. `values` maps each prompted input name to the user's typed
 *  value; main persists them and re-runs that step's entry action. */
export interface FlowProvideInputMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  values: Record<string, string>;
}

/** flow:setTitle request (§22.3.1): the name the user typed into the status bar for `repoKey`'s work. A
 *  blank `title` CLEARS the name. The name is bounded by TITLE_MAX and normalized by `normalizeTitle` —
 *  one predicate, shared with the on-disk store, so what the bar paints and what lands cannot disagree. */
export interface FlowSetTitleMsg {
  sessionId: SessionId;
  repoKey: string;
  title: string;
}

/** flow:setActiveFlow request (§18.7.2/§18.7.4): the catalog `id` the operator picked for `repoKey`'s
 *  worktree. Applied only while the run has never started (AC7). */
export interface FlowSetActiveFlowMsg {
  sessionId: SessionId;
  repoKey: string;
  id: string;
}

/** flow:clearActiveFlow request (§18.7.2/§18.7.4): return `repoKey`'s worktree to the unset default. Gated like
 *  flow:setActiveFlow. */
export interface FlowClearActiveFlowMsg {
  sessionId: SessionId;
  repoKey: string;
}

/** flow:setActiveFlow / flow:clearActiveFlow result (§18.7.4 AC7): the pointer was written or cleared, or the
 *  write was refused with a human-readable `reason` — the run has begun, begun-ness is indeterminate (fail-closed), or the write
 *  faulted. A refused write leaves the prior on-disk selection byte-for-byte unchanged (§18.7.2 AC8). */
export type ActiveFlowWriteResult = { ok: true } | { ok: false; reason: string };

/** §18.7.6 */
export interface FlowListCatalogMsg {
  sessionId: SessionId;
  repoKey: string;
}

export const CATALOG_ORIGINS = ['repo', 'global'] as const;
export type CatalogOrigin = (typeof CATALOG_ORIGINS)[number];

export type FlowCatalogEntry =
  | { available: true; id: string; origin: CatalogOrigin }
  | { available: false; label: string; origin: CatalogOrigin; reason: string };

/** §18.7.2/§18.7.3 — the worktree's active-flow pointer as the picker reflects it: no pick, a pick, or a set pick
 *  that cannot be used (which refuses the run, so it is never shown as the default). */
export type FlowCatalogSelection = { kind: 'unset' } | { kind: 'value'; id: string } | { kind: 'invalid' };

/** §18.1 / §18.7.6 */
export interface FlowCatalogListing {
  entries: FlowCatalogEntry[];
  tierNotices: { origin: CatalogOrigin; notice: string }[];
  selection: FlowCatalogSelection;
  /** Empty unless the worktree's run is held; otherwise every recovery choice, in the order the picker lists them. */
  recoveryOutcomes: RecoveryOutcomeOf[];
}

export type FlowCatalogListResult = { ok: true; listing: FlowCatalogListing } | { ok: false; reason: string };

/** §18.7.3 */
export type RebindChoice = { origin: 'local' } | { origin: CatalogOrigin; id: string } | { origin: 'fallback' };

/** §18.7.3 */
export type RecoveryOutcome = 'resumes' | 'ends';

export type RecoveryOutcomeOf =
  | { choice: RebindChoice; outcome: RecoveryOutcome }
  | { choice: RebindChoice; outcome: 'unavailable'; reason: string };

/** §18.7.3 / §6 — consent to end the run names the held step (as the flow view shows it) the operator confirmed
 *  ending, so the consent never ends a run held anywhere else. */
export type StepMissingConsent = 'refuse' | { endRunHeldAt: string };

/** §18.7.3 */
export type RebindResult =
  | { ok: true; outcome: 'resumed' }
  | { ok: true; outcome: 'terminated'; notice?: string }
  | { ok: false; reason: string };

/** §6 */
export interface FlowRebindHeldRunMsg {
  sessionId: SessionId;
  repoKey: string;
  choice: RebindChoice;
  ifStepMissing: StepMissingConsent;
}

/** The human's gate-decision option set the §27 gate owns (§27.9/§27.15): the option picked at a
 *  data-driven awaiting-human gate, mirroring the LoopDef `human_options` the gate offers. One runtime
 *  source (`GATE_DECISION_OPTIONS`) drives both the type and the §6 validator, so main, renderer, and the
 *  wire cannot drift on the set. The guard that a step never runs an option its bound def does not declare
 *  is enforced at the operation, validated against the def's declared options — never inferred from this
 *  type (AC9). */
export const GATE_DECISION_OPTIONS = ['approve', 'request-changes', 'impasse', 'redo', 'polish', 'back-to-red'] as const;
export type GateDecisionOption = (typeof GATE_DECISION_OPTIONS)[number];

/** The §27-only work-turn error route-out (§27.12c): the human recovers a stopped §27 work turn by
 *  re-running it (`retry`), accepting a present artifact without re-running (`accept`), or moving the flow
 *  off the step (`terminate`). ONE runtime source drives both the type and the §6 validator, so main,
 *  renderer, and the wire cannot drift on the set. Disjoint from `GATE_DECISION_OPTIONS` — a §27-only
 *  route-out concept (§27.15). */
export const APP_ROUTE_OUT_ACTIONS = ['retry', 'accept', 'terminate'] as const;
export type AppRouteOutAction = (typeof APP_ROUTE_OUT_ACTIONS)[number];

/** flow:appRouteOut request (§27.12c): the §27-only work-turn route-out. It carries the identity of the
 *  step and turn it acts on (§6) — the receiver acts on that identity, never ambient loop state — so a
 *  decision for one turn can never fire against another. One-way; the result surfaces through the §27 run
 *  state → flow:onStateChanged re-pull. */
export interface FlowAppRouteOutMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  turnKey: string;
  action: AppRouteOutAction;
}

/** flow:appGateDecision request (§27.9/§27.13 / N5): the human's decision at a §27 (app-namespace) human
 *  gate. Like the §27 route-out it carries the identity of the `step` and `turnKey` it acts on (§6) — the
 *  receiver acts on that identity, never ambient loop state — so a decision for one gate can never fire
 *  against another (AC7). `option` is typed on the SHARED `GATE_DECISION_OPTIONS` set, so the wire, main,
 *  and renderer cannot drift; the guard that a step never runs an option its bound def does not declare is
 *  enforced at the operation, validated against the def's declared options — never inferred from this type
 *  (AC9). One-way; the result surfaces through the §27 run state → flow:onStateChanged re-pull. */
export interface FlowAppGateDecisionMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  turnKey: string;
  option: GateDecisionOption;
}

/** flow:appRequestChanges request (§27.9/§19.4 / AC4): the operator's request-changes decision for `repoKey`,
 *  carrying the `step`+`turnKey` identity it acts on (§6) and the composed `feedback` delivered into the next
 *  review-and-fix round. Two-way (unlike the one-way `appGateDecision`): the reply is whether the round started,
 *  so the feedback composer holds open until delivery confirms and never discards the human's input on a drop. */
export interface FlowAppRequestChangesMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  turnKey: string;
  feedback: string;
}

/** flow:appRedo request (§27.9/AC5): the operator's redo decision for `repoKey`, carrying the `step`+`turnKey`
 *  identity it acts on (§6) and the human `instruction` that re-enters the work turn on a clean slate (only the
 *  ticket, the plan, and that instruction — no findings, no round history). Two-way like appRequestChanges (not
 *  the one-way appGateDecision): the reply is whether the work turn re-entered, so the redo composer holds open
 *  until it confirms and never discards the human's instruction on a drop (runner mid-turn / gate raced out). */
export interface FlowAppRedoMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  turnKey: string;
  instruction: string;
}

/** flow:appBackToRed request (§28.4.2): the operator's back-to-RED decision for `repoKey`, carrying the
 *  `step`+`turnKey` identity it acts on (§6) and the `brief` the reopened slice's RED, GREEN and refactor turns
 *  are handed (empty = a plain reopen). Two-way like appRedo: the reply is whether the flow is back at RED, so
 *  the composer holds open and keeps the brief when the reopen does not land. */
export interface FlowAppBackToRedMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
  turnKey: string;
  brief: string;
}

/** flow:armInterrupt request (§27.9/AC9): the operator arms the queued interrupt for a §27 loop step. It
 *  carries the identity of the `step` it acts on (§6) — the receiver arms that step's interrupt, never one
 *  derived from ambient state — so an arm for one step can never fire against another. One-way; the consolidator
 *  honors it at its next invocation (routing to the gate) and the panel re-pulls via flow:onStateChanged. */
export interface FlowArmInterruptMsg {
  sessionId: SessionId;
  repoKey: string;
  step: string;
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
 *  `repoKey` resolves the flow dir local-first-then-global, since templates are co-located. */
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

// ---- Install bundled examples (§18.1/§23.4/§27.15) ----

/** §18.1/§23.4/§27.15. */
export const INSTALL_DESTINATION_IDS = [
  'flow',
  'flowCatalog',
  'appLoops',
  'commands',
  'agents',
  'codexLoops',
  'codexAgents',
  'codexSkills',
] as const;

export type InstallDestinationId = (typeof INSTALL_DESTINATION_IDS)[number];
export type InstallPreviewId = string & {
  readonly __installPreviewId: unique symbol;
};

/** examples:preview request (§6): report which bundled files would conflict (exist and differ from
 *  the bundled content), driving the up-front consent step. Carries only sessionId — the bundle
 *  sources and install targets are computed by main from the running build. */
export interface InstallExamplesPreviewMsg {
  sessionId: SessionId;
}

/** One destination's preview. The two modes are mutually exclusive: a destination with no conflict
 *  carries no files and asks the user for no decision, so `files` exists only in the conflicting mode
 *  (CLAUDE.md discriminated-union corollary). */
export type InstallDestinationPreview =
  | { destination: InstallDestinationId; conflict: false }
  | { destination: InstallDestinationId; conflict: true; files: DestRelativePath[] };

/** examples:preview result: `ok` with one entry per destination the action would write, or `!ok` with a
 *  human-readable `error` when the request itself was refused. The error arm is distinct from a clean
 *  `ok` with no conflicts: an empty destination list would otherwise read as "nothing conflicts", so a
 *  refused request could drive an apply the user never consented to. Observing a preview never writes
 *  anything (§18.1). */
export type InstallExamplesPreview =
  | {
      ok: true;
      previewId: InstallPreviewId;
      destinations: InstallDestinationPreview[];
      retired: RetiredExample[];
      /** §18.1: the retired flow the installed fallback flow.yaml still is, or null. */
      retiredFallback: string | null;
    }
  | { ok: false; error: string };

/** examples:apply request (§6/§18.1). */
export interface InstallExamplesApplyMsg {
  sessionId: SessionId;
  previewId: InstallPreviewId;
  replace: InstallDestinationId[];
  removeRetired: boolean;
}

/** §18.1. `rel` is one entry directly under the destination's root: a whole folder or a single file. */
export interface RetiredExample {
  destination: InstallDestinationId;
  rel: DestRelativePath;
}

/** A file's path relative to the root of the destination it installs under. A plain `string` is not
 *  assignable to it, so every value is minted at one checked place (`destRelative`) — an absolute path or
 *  one escaping its destination is refused there rather than travelling as a legal-looking value. */
export type DestRelativePath = string & { readonly __destRelative: unique symbol };

/** Files reported under the destination they were written to, so two destinations sharing a file name
 *  yield two distinct, attributable entries. */
export interface InstallDestinationFiles {
  destination: InstallDestinationId;
  files: DestRelativePath[];
}

/** The files an apply touched, grouped by the destination each was written to (§18.1). `skipped` is
 *  "left byte-for-byte unchanged" — either the target already matched the bundle, or it differed and the
 *  user did not consent to replace in that destination. A write the safe-path primitive refuses
 *  (symlinked container, CWE-59) is an `error`, never a silent skip. */
export interface InstallExamplesWritten {
  created: InstallDestinationFiles[];
  overwritten: InstallDestinationFiles[];
  skipped: InstallDestinationFiles[];
}

/** A destination skipped because the tool it installs for is absent: `root` is that tool's home, which does
 *  not exist (§18.1). */
export interface InstallDestinationNotInstalled {
  destination: InstallDestinationId;
  root: string;
}

export interface InstallExamplesReport extends InstallExamplesWritten {
  notInstalled: InstallDestinationNotInstalled[];
  removed: RetiredExample[];
}

/** examples:apply result: `ok`, or `!ok` with a human-readable `error`. Both arms carry the same report:
 *  the action does not roll back a write that already landed, so a failure names exactly what it wrote —
 *  and what it left alone — before failing. The report is empty when the install was refused before any
 *  write, which is the all-or-nothing case. */
export type InstallExamplesResult =
  | ({ ok: true } & InstallExamplesReport)
  | ({ ok: false; error: string } & InstallExamplesReport);

// ---- Preload-exposed API surfaces (§6) ----

/** Host OS, exposed to the renderer so it can resolve the `auto` keymap profile (§7.7). */
export type OsPlatform = 'darwin' | 'win32' | 'linux';

export interface TermApi {
  startup: StartupApi;
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
  /** in_progress → done; rejects if not currently in_progress. `step`, when given, names the step the caller
   *  showed: an Advance naming a step the flow has left advances nothing (§27.9.1 N9b.5(e), §6). */
  advance(repoKey: string, step?: string): Promise<FlowStateView>;
  /** done → in_progress; resets and re-runs the first step. Rejects if not currently done. */
  restart(repoKey: string): Promise<FlowStateView>;
  /** done → in_progress; reverts a manual advance WITHOUT re-running the step's entry actions
   *  (unlike restart). Rejects if not currently done. */
  undo(repoKey: string): Promise<FlowStateView>;
  /** in_progress|done → not_started (#26): abandons the flow, discarding carried-over inputs, and
   *  resolves to the reset (not_started) view. Inert from not_started / load-error. Main also clears
   *  the repo's todos, the global capture tab, and finalizes the audit run as one user-confirmed action. */
  terminate(repoKey: string): Promise<FlowStateView>;
  /** Answer a step-entry input `prompt` (§18.4 / §24.2.3 T3): persist the typed `values` only while
   *  `step` is still current, then re-run its entry action and return the new view. */
  provideInput(repoKey: string, step: string, values: Record<string, string>): Promise<FlowStateView>;
  /** Name the repo's work, or clear the name with a blank (§22.3.1). Resolves to the new view; unlike the
   *  other flow:* calls, an unsafe or unregistered-repo target REJECTS rather than resolving to a benign
   *  error view (§22.3.1). */
  setTitle(repoKey: string, title: string): Promise<FlowStateView>;
  /** Select the worktree's active flow (§18.7.2/§18.7.4). Permitted only while the run has never started;
   *  once it has begun — or while begun-ness cannot be verified — the write is refused with a reason (AC7).
   *  A3's picker mirrors this in its enable state, but this is the authoritative main-side gate. */
  setActiveFlow(repoKey: string, id: string): Promise<ActiveFlowWriteResult>;
  /** Return the worktree to the unset default flow; gated exactly like `setActiveFlow`. */
  clearActiveFlow(repoKey: string): Promise<ActiveFlowWriteResult>;
  /** §18.7.6 */
  listCatalog(repoKey: string): Promise<FlowCatalogListResult>;
  /** §18.7.3 */
  rebindHeldRun(repoKey: string, choice: RebindChoice, ifStepMissing: StepMissingConsent): Promise<RebindResult>;
  /** §27.13 */
  confirmRunPickup(repoKey: string, run: RunIdentity, pr: number, ticket: number): Promise<ConfirmRunPickupResult>;
  /** Subscribe to main's flow:onStateChanged push (§24.2.2 S5): `cb` fires when a flow-relevant
   *  input changed (todo/activity), prompting a `state()` re-pull. Returns an unsubscribe. */
  onStateChanged(cb: () => void): () => void;
  /** Subscribe to main's flow:revealLoop push (§24.2.3 T4): `cb` fires when the OS attention
   *  notification was activated and the loop read-out must be revealed. Returns an unsubscribe. */
  onRevealLoop(cb: () => void): () => void;
  /** Subscribe to main's flow:onBootstrapError push (§27.10): `cb` fires with the human-readable `reason`
   *  and the failed repo/step identity when a loop step's bootstrap could not proceed (an async pickup that
   *  rolled back, or a declared bootstrap the bound def has no contract for); the renderer raises a blocking
   *  error dialog. Returns an unsubscribe. */
  onBootstrapError(cb: (reason: string, repoKey: string, step: string) => void): () => void;
  /** Subscribe to main's flow:onLoopError push (§27.12/§28.3): `cb` fires with the human-readable
   *  `reason` and its `kind` — `'error'` (a loop-mechanics failure → blocking error dialog) or `'notice'`
   *  (a benign completed no-op → framed as a notice, not a failure). Returns an unsubscribe. */
  onLoopError(cb: (reason: string, kind: FlowLoopMessageKind) => void): () => void;
  /** §6/§27.10. */
  onAppBootstrapConflict(
    cb: (
      conflict: AppBootstrapConflictTarget & { repoKey: string; step: string },
    ) => void,
  ): () => void;
  /** §6/§27.10. */
  resolveAppBootstrapConflict(
    repoKey: string,
    step: string,
    wipe: boolean,
    target: AppBootstrapConflictTarget,
  ): void;
  /** §6/§28.7 — subscribe to the epic-promotion confirm-first preview (main → renderer). Returns unsubscribe. */
  onEpicPromotionPreview(
    cb: (preview: { repoKey: string; step: string; epic: number; pr: number | null; subTickets: { index: number; title: string }[] }) => void,
  ): () => void;
  /** §6/§28.7 — answer the confirm-first preview (renderer → main): confirm runs the promotion, else decline. */
  resolveEpicPromotion(repoKey: string, step: string, confirm: boolean): void;
  /** Resolve a GitHub ref's title/body/url for the popout (§24.2.3 T7), best-effort: null when it
   *  can't be resolved (no `gh`, not a GitHub repo, offline) so the popout shows the number alone. */
  githubRef(repoKey: string, kind: GithubRefKind, number: number): Promise<GithubRef | null>;
  /** Open a ref's GitHub `url` in the OS browser (§24.2.3 T7); resolves to whether it was opened
   *  (false when main rejects the url as non-GitHub/non-https). */
  openExternal(url: string): Promise<boolean>;
  /** §27.12c — the §27-only work-turn route-out for `repoKey`, carrying the `step`+`turnKey` identity it
   *  acts on (§6). `retry` re-runs the turn, `accept` advances a present artifact without re-running,
   *  `terminate` moves the flow off the step. One-way: the loop panel re-pulls via flow:onStateChanged. */
  appRouteOut(repoKey: string, step: string, turnKey: string, action: AppRouteOutAction): void;
  /** §27.9/§27.13 (N5) — submit the human's §27 gate decision for `repoKey`, carrying the `step`+`turnKey`
   *  identity it acts on (§6). `approve` runs the bound loop's declared side-effect out of band and reaches
   *  the terminal accept; a legacy step never fires this path (AC8) and an option the bound def does not
   *  declare is rejected at the operation (AC9). One-way: the loop panel re-pulls via flow:onStateChanged. */
  appGateDecision(repoKey: string, step: string, turnKey: string, option: GateDecisionOption): void;
  /** §27.9/§19.4 (AC4) — submit a request-changes decision for `repoKey`, carrying the `step`+`turnKey` identity
   *  (§6) and the composed `feedback` for the next review-and-fix round. Resolves whether the round started, so
   *  the feedback composer holds open until delivery confirms — a drop (runner mid-turn / gate raced out) never
   *  discards the human's input. */
  appRequestChanges(repoKey: string, step: string, turnKey: string, feedback: string): Promise<boolean>;
  /** §27.9/AC5 — submit a redo decision for `repoKey`, carrying the `step`+`turnKey` identity (§6) and the human
   *  `instruction` that re-enters the work turn on a clean slate (ticket + plan + instruction only). Resolves
   *  whether the work turn re-entered, so the redo composer holds open until it confirms — a drop (runner
   *  mid-turn / gate raced out) never discards the human's instruction. */
  appRedo(repoKey: string, step: string, turnKey: string, instruction: string): Promise<boolean>;
  /** §28.4.2 — send `repoKey`'s current slice back to RED from the gate at `step`+`turnKey` (§6), carrying the
   *  `brief` its RED, GREEN and refactor turns are handed (empty = a plain reopen). Resolves whether the flow is
   *  back at RED, so the composer holds open and keeps the brief when it is not. */
  appBackToRed(repoKey: string, step: string, turnKey: string, brief: string): Promise<boolean>;
  /** §27.9/AC9 — arm the queued interrupt for `repoKey`'s §27 loop `step` (the identity it acts on, §6). The
   *  consolidator honors it at its next invocation, routing to the human gate. One-way: the loop panel
   *  re-pulls via flow:onStateChanged when the resulting state lands. */
  armInterrupt(repoKey: string, step: string): void;
}

/** CLI launcher install (§23.4 / #25): the settings affordance's only seam to the install action. */
export interface CliApi {
  /** Install the `agent-terminal` launch shim onto PATH, reconciling to the running build. */
  install(): Promise<CliInstallResult>;
}

/** Install bundled examples (§18.1/§23.4/§27.15): the settings organism's only seam to the install action.
 *  Observing a preview never writes anything. */
export interface ExamplesApi {
  preview(): Promise<InstallExamplesPreview>;
  apply(
    previewId: InstallPreviewId,
    replace: InstallDestinationId[],
    removeRetired: boolean,
  ): Promise<InstallExamplesResult>;
}

declare global {
  interface Window {
    term: TermApi;
    monitor: MonitorApi;
    viewer: ViewerApi;
    flow: FlowApi;
    cli: CliApi;
    examples: ExamplesApi;
    controller: ControllerApi;
  }
}
export type ControllerWorkStatus = {
  unavailableReason?: 'message-too-large';
  flow: { availability: 'loading' | 'unavailable' } | {
    availability: 'known'; name: string; step: string;
    assignment: 'unassigned' | 'assigned' | 'completed' | 'unavailable';
  };
  ticket: { availability: 'loading' | 'unavailable' | 'none' } | {
    availability: 'known'; number: number;
    title: { availability: 'loading' | 'unavailable' } | { availability: 'known'; text: string };
  };
  activity: 'active' | 'quiet' | 'unavailable';
  attention: null | { status: string; reasons: string[] };
  error: null | { reason: string };
};

export interface ControllerTerminal {
  work?: ControllerWorkStatus;
  status?: 'connected' | 'disconnected';
  id: string;
  launchDirectory: string;
  repositoryRoot: string | null;
}

export interface ControllerApi {
  subscribeTerminals(listener: (terminals: ControllerTerminal[]) => void): () => void;
  activateTerminal(id: string): Promise<'activated' | 'unavailable'>;
  dismissTerminal(id: string): Promise<void>;
}

export const CONTROLLER_CH = {
  subscribe: 'controller:subscribe',
  terminals: 'controller:terminals',
  activate: 'controller:activate',
  dismiss: 'controller:dismiss',
} as const;
export const CONTROLLER_WINDOW_ARGUMENT = '--agent-terminal-controller-window';

export interface ControllerSnapshot { sessionId: SessionId; terminals: ControllerTerminal[] }
export interface ControllerActivation { sessionId: SessionId; id: string }


export interface ControllerVersionRange { min: number; max: number }
export interface ControllerIncompatibility {
  update: 'controller' | 'terminal';
  terminalVersion: number;
  controllerVersions: ControllerVersionRange;
}
export interface StartupIncompatibleMsg extends ControllerIncompatibility { sessionId: SessionId }

export interface StartupApi {
  ready(): Promise<void>;
  rendered(): void;
  onIncompatible(cb: (report: ControllerIncompatibility) => void): () => void;
}
