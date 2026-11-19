// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createControllerClock } from '../../src/renderer/src/controllerFrame';

const WALL_TIME = Date.UTC(2026, 10, 6, 9, 30);
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(WALL_TIME);
});
afterEach(() => vi.useRealTimers());

describe('the controller clock', () => {
  it('reads wall time, so a time in state keeps counting across a sleep', () => {
    const clock = createControllerClock(window);
    const first = clock.now();
    vi.setSystemTime(WALL_TIME + 8 * 60 * MINUTE);
    expect({ first, later: clock.now() }).toEqual({ first: WALL_TIME, later: WALL_TIME + 8 * 60 * MINUTE });
  });

  it('ticks within every minute while a listener is subscribed', () => {
    const clock = createControllerClock(window);
    let ticks = 0;
    clock.onTick(() => { ticks += 1; });
    const seen = [1, 2, 3].map(() => {
      const before = ticks;
      vi.advanceTimersByTime(MINUTE);
      return ticks > before;
    });
    expect(seen).toEqual([true, true, true]);
  });

  it('stops ticking a listener once it unsubscribes', () => {
    const clock = createControllerClock(window);
    let ticks = 0;
    const unsubscribe = clock.onTick(() => { ticks += 1; });
    vi.advanceTimersByTime(3 * MINUTE);
    const before = ticks;
    unsubscribe();
    vi.advanceTimersByTime(10 * MINUTE);
    expect.soft(before, 'ticks while subscribed').toBeGreaterThan(0);
    expect(ticks, 'ticks after unsubscribing').toBe(before);
  });
});
