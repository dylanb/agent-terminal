const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One tool call the server hands to its window. */
export interface WindowRequest {
  tool: string;
  args: unknown;
}

/** The Claude Code session a call comes from: its process id, or null when the server could not tell. */
export interface McpCaller {
  session: number | null;
  tmux?: McpTmux;
}

/** A window's answer to a call it did not carry out as asked: a `refusal` names one of the ticket's refusal
 *  reasons and changed nothing; `neither` is an outcome that is neither success nor refusal. Every other answer is a
 *  success, and its fields are the call's result. */
export interface WindowAnswerFailure {
  outcome: 'refusal' | 'neither';
  kind: string;
  message: string;
}

export function isWindowAnswerFailure(value: unknown): value is WindowAnswerFailure {
  return isRecord(value) && (value.outcome === 'refusal' || value.outcome === 'neither') && typeof value.kind === 'string' && typeof value.message === 'string';
}

/** `app-unreachable`: the window never started the operation. `result-unknown`: the connection was lost after it
 *  started, so it may have run. */
export type WindowCallOutcome =
  | { kind: 'answered'; value: unknown }
  | { kind: 'app-unreachable'; reason: string }
  | { kind: 'result-unknown'; reason: string };

export interface AckTimers<H = unknown> {
  setTimer(cb: () => void, ms: number): H;
  clearTimer(handle: H): void;
}

/** The bridge conversation, one JSON object per line: the server says `hello` with its build, the window answers
 *  `ack` (or `other-build`, and runs nothing), only then does the server send its `call`, and the window answers
 *  with the `result`, or `failed` with its reason. A window that never reads the `call` has run nothing. `hello`, `ack` and `other-build` keep
 *  this shape in every build, so two builds always recognise each other as different. */
export type BridgeMessage =
  | { type: 'hello'; build: string }
  | { type: 'ack' }
  | { type: 'other-build' }
  | { type: 'call'; request: WindowRequest; caller: McpCaller }
  | { type: 'result'; value: unknown }
  | { type: 'failed'; reason: string };

const MAX_BRIDGE_LINE = 16 * 1024 * 1024;

export function encodeBridgeMessage(message: BridgeMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export interface McpTmux {
  socket: string;
  searchPath: string;
}

export function isMcpTmux(value: unknown): value is McpTmux {
  return isRecord(value) && typeof value.socket === 'string' && value.socket.startsWith('/') && !value.socket.includes('\0')
    && typeof value.searchPath === 'string' && !value.searchPath.includes('\0');
}

const callerOf = (value: unknown): McpCaller => ({
  session: sessionOf(value),
  ...(isRecord(value) && isMcpTmux(value.tmux) ? { tmux: { socket: value.tmux.socket, searchPath: value.tmux.searchPath } } : {}),
});

/** A caller whose session is not a process id is judged as one the server could not tell. */
const sessionOf = (caller: unknown): number | null =>
  isRecord(caller) && typeof caller.session === 'number' && Number.isSafeInteger(caller.session) && caller.session > 0 ? caller.session : null;

/** A line's message, or null when it is not one this build reads. */
export function parseBridgeMessage(line: string): BridgeMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  switch (parsed.type) {
    case 'hello':
      return typeof parsed.build === 'string' ? { type: 'hello', build: parsed.build } : null;
    case 'ack':
      return { type: 'ack' };
    case 'other-build':
      return { type: 'other-build' };
    case 'call':
      return isRecord(parsed.request) && typeof parsed.request.tool === 'string'
        ? { type: 'call', request: { tool: parsed.request.tool, args: parsed.request.args }, caller: callerOf(parsed.caller) }
        : null;
    case 'result':
      return { type: 'result', value: parsed.value };
    case 'failed':
      return typeof parsed.reason === 'string' ? { type: 'failed', reason: parsed.reason } : null;
    default:
      return null;
  }
}

/** Feeds decoded text in and hands each complete line's message, or null for a line it does not read or one past
 *  the size limit, to `onMessage`. */
export function bridgeLineReader(onMessage: (message: BridgeMessage | null) => void): (text: string) => void {
  let buffer = '';
  return (text) => {
    buffer += text;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      onMessage(line.length > MAX_BRIDGE_LINE ? null : parseBridgeMessage(line));
    }
    if (buffer.length > MAX_BRIDGE_LINE) {
      buffer = '';
      onMessage(null);
    }
  };
}
