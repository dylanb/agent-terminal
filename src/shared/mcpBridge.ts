/** One tool call the server hands to its window. */
export interface WindowRequest {
  tool: string;
  args: unknown;
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
  | { type: 'call'; request: WindowRequest }
  | { type: 'result'; value: unknown }
  | { type: 'failed'; reason: string };

const MAX_BRIDGE_LINE = 16 * 1024 * 1024;

export function encodeBridgeMessage(message: BridgeMessage): string {
  return `${JSON.stringify(message)}\n`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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
        ? { type: 'call', request: { tool: parsed.request.tool, args: parsed.request.args } }
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
      onMessage(parseBridgeMessage(line));
    }
    if (buffer.length > MAX_BRIDGE_LINE) {
      buffer = '';
      onMessage(null);
    }
  };
}
