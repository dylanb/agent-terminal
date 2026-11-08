import type { AgentState } from '../shared/ipc';
import { sameWaitingValue, type ControllerActivity, type WaitingValue } from '../shared/waiting';
import { errMsg } from './errno';

export type { ControllerActivity } from '../shared/waiting';

/** The pause between one lookup settling and the next starting. */
export const WAITING_POLL_GAP_MS = 1000;
/** How long after the screen goes quiet the controller keeps showing Working before it shows Idle. */
export const WAITING_GRACE_MS = 3000;

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
  /** Stops every lookup for good; the activity then reads quiet. */
  dispose(): void;
}

function sameActivity(a: ControllerActivity, b: ControllerActivity): boolean {
  if (a.activity === 'waiting' || b.activity === 'waiting') {
    return a.activity === b.activity && sameWaitingValue(a.activity === 'waiting' ? a.waiting : null, b.activity === 'waiting' ? b.waiting : null);
  }
  return a.activity === b.activity;
}

/**
 * The controller's activity: the screen's while it is active, and while it is quiet, Waiting when the latest
 * settled lookup found a command. For `WAITING_GRACE_MS` after the screen goes quiet it shows Working rather than
 * Idle, so a command that is already running is never preceded by a quiet frame. Lookups run one at a time and
 * only while the screen is quiet; one that fails or misses `lookupTimeoutMs` reads as no commands.
 */
export function createWaitingDetector(deps: WaitingDetectorDeps): WaitingDetector {
  const { timers } = deps;
  let screen: AgentState | null = null;
  let inGrace = false;
  let latest: WaitingValue | null = null;
  let shown: ControllerActivity = { activity: 'quiet' };
  let generation = 0;
  let disposed = false;
  let lastFailure: string | undefined;
  const pending = new Set<unknown>();
  let inFlight: AbortController | undefined;

  const after = (ms: number, cb: () => void): unknown => {
    const handle = timers.setTimer(() => {
      pending.delete(handle);
      cb();
    }, ms);
    pending.add(handle);
    return handle;
  };
  const cancel = (handle: unknown): void => {
    if (pending.delete(handle)) timers.clearTimer(handle);
  };
  const stop = (): void => {
    generation += 1;
    for (const handle of pending) timers.clearTimer(handle);
    pending.clear();
    inFlight?.abort();
    inFlight = undefined;
  };

  const show = (): void => {
    const next: ControllerActivity = screen === 'active' ? { activity: 'active' }
      : latest ? { activity: 'waiting', waiting: latest }
      : inGrace ? { activity: 'active' }
      : { activity: 'quiet' };
    if (sameActivity(shown, next)) return;
    shown = next;
    try {
      deps.onChange(next);
    } catch (error) {
      console.error(`Waiting activity not delivered: ${errMsg(error)}`);
    }
  };

  const failed = (failure: string): void => {
    if (failure !== lastFailure) console.error(`Waiting lookup failed: ${failure}`);
    lastFailure = failure;
  };

  const lookUp = (): void => {
    const owner = generation;
    const abort = new AbortController();
    inFlight = abort;
    let settled = false;
    const settle = (value: WaitingValue | null): void => {
      if (settled) return;
      settled = true;
      cancel(bound);
      if (owner !== generation) return;
      inFlight = undefined;
      latest = value && { program: value.program, others: value.others };
      show();
      after(WAITING_POLL_GAP_MS, lookUp);
    };
    const bound = after(deps.lookupTimeoutMs, () => {
      abort.abort();
      failed(`no answer within ${deps.lookupTimeoutMs} ms`);
      settle(null);
    });
    let lookup: Promise<WaitingValue | null>;
    try {
      lookup = deps.commands(abort.signal);
    } catch (error) {
      lookup = Promise.reject(error);
    }
    lookup.then((value) => {
      if (!settled) lastFailure = undefined;
      settle(value);
    }, (error: unknown) => {
      if (!settled && owner === generation) failed(errMsg(error));
      settle(null);
    });
  };

  return {
    screen(state) {
      if (disposed || state === screen) return;
      const wasActive = screen === 'active';
      screen = state;
      stop();
      latest = null;
      inGrace = state === 'quiet' && wasActive;
      if (inGrace) {
        after(WAITING_GRACE_MS, () => {
          inGrace = false;
          show();
        });
      }
      show();
      if (state === 'quiet') lookUp();
    },
    current: () => shown,
    dispose() {
      disposed = true;
      stop();
      shown = { activity: 'quiet' };
    },
  };
}
