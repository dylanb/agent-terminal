import type { ChannelSpecs, SessionId } from './session';
import type { UiSettings } from './settings';
import type { PtyExitMsg } from './terminal';
import type { TodoItem, TodoSource, TodoStatus, TodoTemplateList } from './todo';

export const MONITOR_CHANNELS = {
  monitorCapture: {
    name: 'monitor:capture',
    does: 'The renderer sends a region the user captured, which main stamps and broadcasts back on monitor:event.',
  },
  monitorEvent: {
    name: 'monitor:event',
    does: 'Main sends a manual capture, semantic event or command-output block to the monitor pane.',
  },
  monitorEventRemoved: {
    name: 'monitor:eventRemoved',
    does: 'Main retracts an earlier semantic event that a fuller capture superseded.',
  },
  monitorUpdate: {
    name: 'monitor:update',
    does: 'Main sends debounced status changes for the alternate screen, bracketed paste and agent activity.',
  },
  monitorReplay: {
    name: 'monitor:replay',
    does: 'A reloaded monitor pane asks for every capture stamped so far.',
  },
  monitorCurrentRepo: {
    name: 'monitor:currentRepo',
    does: "The monitor pane asks for the agent's current repo, so it learns the repo key even if it missed cwd:changed.",
  },
  captureLast: {
    name: 'capture:last',
    does: 'The renderer asks main to detect reports on the current screen now and return the latest one with its findings.',
  },
  monitorDismiss: {
    name: 'monitor:dismiss',
    does: 'The renderer removes one captured event, and dismissing a report also removes its findings.',
  },
  monitorDismissAll: {
    name: 'monitor:dismissAll',
    does: 'The renderer clears every captured event from the store.',
  },
  monitorCleared: {
    name: 'monitor:cleared',
    does: 'Main reports that it cleared the capture store, for example on a flow Terminate, so the pane drops every capture.',
  },
  monitorLearnChrome: {
    name: 'monitor:learnChrome',
    does: 'The renderer marks a captured block as terminal chrome, so main learns its leading glyphs and retracts the capture.',
  },
  agentInject: {
    name: 'agent:inject',
    does: 'The renderer sends text to paste into the agent, wrapped for the live paste mode and optionally submitted.',
  },
  cwdChanged: {
    name: 'cwd:changed',
    does: "Main reports that the agent's repo key changed, so the pane re-reads its todo list.",
  },
} as const satisfies ChannelSpecs;

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
