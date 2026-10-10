export type TimerHandle = { readonly id: number };

/** A manual scheduler for integration tests that must not use `vi.useFakeTimers()` (the engine harness
 *  flushes on a real `setTimeout`). Time moves only through `advanceBy`. */
export interface VirtualClock {
  /** Arms `cb` to fire once `now()` reaches `now() + ms`; a zero or negative `ms` is due immediately. */
  setTimer(cb: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  now(): number;
  /** Moves `now()` forward by `ms`, firing every timer due within the window in due order (ties in arming
   *  order), including timers armed by those callbacks. While a timer fires, `now()` reads its due time, or the
   *  pre-advance time for a timer that was already overdue. */
  advanceBy(ms: number): void;
}

const MAX_FIRES_PER_ADVANCE = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface Pending {
  readonly handle: TimerHandle;
  readonly due: number;
  readonly cb: () => void;
}

export function createVirtualClock(start = 0): VirtualClock {
  let current = start;
  let nextId = 0;
  let pending: Pending[] = [];

  const nextDue = (limit: number): Pending | undefined => {
    let best: Pending | undefined;
    for (const p of pending) {
      if (p.due <= limit && (!best || p.due < best.due || (p.due === best.due && p.handle.id < best.handle.id))) best = p;
    }
    return best;
  };

  return {
    setTimer(cb, ms) {
      if (Number.isNaN(ms) || ms > MAX_TIMER_DELAY_MS) throw new RangeError(`setTimer needs a delay a real timer honours (at most ${MAX_TIMER_DELAY_MS} ms); got ${ms}`);
      const handle = { id: nextId++ };
      pending.push({ handle, due: current + ms, cb });
      return handle;
    },
    clearTimer(handle) {
      pending = pending.filter((p) => p.handle !== handle);
    },
    now: () => current,
    advanceBy(ms) {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`advanceBy needs a finite, non-negative ms; got ${ms}`);
      const target = current + ms;
      let fires = 0;
      for (let p = nextDue(target); p; p = nextDue(target)) {
        if (++fires > MAX_FIRES_PER_ADVANCE) throw new RangeError(`advanceBy(${ms}) fired more than ${MAX_FIRES_PER_ADVANCE} timers; a timer is re-arming itself inside the window`);
        const fired = p;
        pending = pending.filter((q) => q !== fired);
        current = Math.max(current, fired.due);
        fired.cb();
      }
      current = target;
    },
  };
}
