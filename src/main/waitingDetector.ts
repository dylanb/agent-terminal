import type { AgentState } from '../shared/ipc';
import type { WaitingValue } from '../shared/waiting';

/** What the controller reports for the terminal's activity. */
export type ControllerActivity =
  | { readonly activity: 'active' }
  | { readonly activity: 'quiet' }
  | { readonly activity: 'waiting'; readonly waiting: WaitingValue };

export interface WaitingTimers {
  setTimer(cb: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface WaitingDetectorDeps {
  /** The agent's commands running now, or null when none is; aborting the signal abandons the lookup. */
  commands(signal: AbortSignal): Promise<WaitingValue | null>;
  timers: WaitingTimers;
  lookupTimeoutMs: number;
  onChange(activity: ControllerActivity): void;
}

export interface WaitingDetector {
  /** The screen-based activity changed. */
  screen(state: AgentState): void;
  current(): ControllerActivity;
  dispose(): void;
}

export function createWaitingDetector(deps: WaitingDetectorDeps): WaitingDetector {
  let current: ControllerActivity = { activity: 'quiet' };
  return {
    screen(state) {
      current = { activity: state };
      deps.onChange(current);
    },
    current: () => current,
    dispose() {},
  };
}
