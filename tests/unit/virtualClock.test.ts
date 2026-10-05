import { describe, expect, it } from 'vitest';
import { createVirtualClock } from '../helpers/virtualClock';

describe('virtual clock — a manual scheduler for integration tests', () => {
  it('starts at the given epoch and only moves when advanced', () => {
    const clock = createVirtualClock(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advanceBy(250);
    expect(clock.now()).toBe(1_250);
  });

  it('fires a timer once its due time is reached, not before', () => {
    const clock = createVirtualClock();
    const fired: number[] = [];
    clock.setTimer(() => fired.push(clock.now()), 100);
    clock.advanceBy(99);
    expect(fired).toEqual([]);
    clock.advanceBy(1);
    expect(fired).toEqual([100]);
    clock.advanceBy(1_000);
    expect(fired).toEqual([100]);
  });

  it('fires due timers in due order, each observing its own due time as now', () => {
    const clock = createVirtualClock();
    const fired: string[] = [];
    clock.setTimer(() => fired.push(`c@${clock.now()}`), 30);
    clock.setTimer(() => fired.push(`a@${clock.now()}`), 10);
    clock.setTimer(() => fired.push(`b@${clock.now()}`), 20);
    clock.advanceBy(50);
    expect(fired).toEqual(['a@10', 'b@20', 'c@30']);
    expect(clock.now()).toBe(50);
  });

  it('fires timers sharing a due time in the order they were armed', () => {
    const clock = createVirtualClock();
    const fired: string[] = [];
    clock.setTimer(() => fired.push('first'), 5);
    clock.setTimer(() => fired.push('second'), 5);
    clock.advanceBy(5);
    expect(fired).toEqual(['first', 'second']);
  });

  it('fires a timer armed by a callback during the advance when it falls due inside the window', () => {
    const clock = createVirtualClock();
    const fired: string[] = [];
    clock.setTimer(() => {
      fired.push(`outer@${clock.now()}`);
      clock.setTimer(() => fired.push(`inner@${clock.now()}`), 15);
      clock.setTimer(() => fired.push(`late@${clock.now()}`), 100);
    }, 10);
    clock.advanceBy(30);
    expect(fired).toEqual(['outer@10', 'inner@25']);
    clock.advanceBy(80);
    expect(fired).toEqual(['outer@10', 'inner@25', 'late@110']);
  });

  it('fires a zero- or negative-delay timer on the first advanceBy(0)', () => {
    const clock = createVirtualClock(500);
    const fired: string[] = [];
    clock.setTimer(() => fired.push('zero'), 0);
    clock.setTimer(() => fired.push('negative'), -20);
    expect(fired).toEqual([]);
    clock.advanceBy(0);
    expect(fired).toEqual(['negative', 'zero']);
    expect(clock.now()).toBe(500);
  });

  it('never fires a cleared timer, and clearing an already-fired or unknown handle is harmless', () => {
    const clock = createVirtualClock();
    const fired: string[] = [];
    const cancelled = clock.setTimer(() => fired.push('cancelled'), 10);
    const kept = clock.setTimer(() => fired.push('kept'), 10);
    clock.clearTimer(cancelled);
    clock.advanceBy(10);
    expect(fired).toEqual(['kept']);
    expect(() => clock.clearTimer(kept)).not.toThrow();
  });

  it('lets a firing callback cancel a later timer due in the same window', () => {
    const clock = createVirtualClock();
    const fired: string[] = [];
    const victim = clock.setTimer(() => fired.push('victim'), 20);
    clock.setTimer(() => {
      fired.push('canceller');
      clock.clearTimer(victim);
    }, 10);
    clock.advanceBy(30);
    expect(fired).toEqual(['canceller']);
  });

  it('rejects a negative or non-finite advance', () => {
    const clock = createVirtualClock();
    expect(() => clock.advanceBy(-1)).toThrow();
    expect(() => clock.advanceBy(Number.NaN)).toThrow();
  });

  it('rejects a delay a real timer would not honour, so an unvalidated bound cannot pass here and fire at once in production', () => {
    const clock = createVirtualClock();
    for (const ms of [Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => clock.setTimer(() => {}, ms)).toThrow(RangeError);
    }
    expect(() => clock.setTimer(() => {}, 2_147_483_647)).not.toThrow();
  });

  it('throws on a timer that keeps re-arming itself inside the window instead of spinning the worker', () => {
    const clock = createVirtualClock();
    let fires = 0;
    const rearm = (): void => {
      fires += 1;
      if (fires < 50_000) clock.setTimer(rearm, 0);
    };
    clock.setTimer(rearm, 0);
    expect(() => clock.advanceBy(10)).toThrow(RangeError);
  });
});
