const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface WindowRequest {
  tool: string;
  args: unknown;
}

export interface McpCaller {
  session: number | null;
  tmux?: McpTmux;
}

export interface WindowAnswerFailure {
  outcome: 'refusal' | 'neither';
  kind: string;
  message: string;
}

export function isWindowAnswerFailure(value: unknown): value is WindowAnswerFailure {
  return isRecord(value) && (value.outcome === 'refusal' || value.outcome === 'neither') && typeof value.kind === 'string' && typeof value.message === 'string';
}

export type WindowCallOutcome =
  | { kind: 'answered'; value: unknown }
  | { kind: 'app-unreachable'; reason: string }
  | { kind: 'result-unknown'; reason: string };

export interface AckTimers<H = unknown> {
  setTimer(cb: () => void, ms: number): H;
  clearTimer(handle: H): void;
}

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

const sessionOf = (caller: unknown): number | null =>
  isRecord(caller) && typeof caller.session === 'number' && Number.isSafeInteger(caller.session) && caller.session > 0 ? caller.session : null;

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
