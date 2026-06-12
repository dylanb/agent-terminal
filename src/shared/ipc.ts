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
  monitorUpdate: 'monitor:update',
  monitorReplay: 'monitor:replay',
  agentInject: 'agent:inject',
} as const;

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

/** Event shape the future semantic pipeline will emit (§8.4). */
export interface MonitorEvent {
  id: string;
  sessionId: SessionId;
  type: 'capture';
  source: 'selection';
  text: string;
  range: SelectionRange | null;
  capturedAt: string;
}

export interface MonitorEventMsg {
  sessionId: SessionId;
  event: MonitorEvent;
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
  onUpdate(cb: (msg: MonitorUpdateMsg) => void): void;
  onExit(cb: (msg: PtyExitMsg) => void): void;
  replay(): Promise<MonitorEvent[]>;
  inject(req: Omit<AgentInjectMsg, 'sessionId'>): void;
}

declare global {
  interface Window {
    term: TermApi;
    monitor: MonitorApi;
  }
}
