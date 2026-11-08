import type { AckTimers, WindowCallOutcome, WindowRequest } from '../shared/mcpBridge';

/** The server's end of the bridge: one call to the window at `endpoint`. */
export async function callWindow<H>(
  _endpoint: string,
  _request: WindowRequest,
  _opts: { build: string; ackTimeoutMs: number; timers: AckTimers<H> },
): Promise<WindowCallOutcome> {
  return { kind: 'answered', value: undefined };
}
