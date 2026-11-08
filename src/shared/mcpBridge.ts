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
