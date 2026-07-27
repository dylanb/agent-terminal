/** Event-loop iterations elapsed, counted by a self-rescheduling check-phase callback — ordering only,
 *  with no wall clock: `setImmediate` fires once per iteration, where a zero timer is clamped to a
 *  millisecond and would report nothing for work that yields many times inside one. */
export function eventLoopTicker(): { ticks: () => number; stop: () => void } {
  let ticks = 0;
  let running = true;
  const pump = (): void => {
    if (!running) return;
    ticks += 1;
    setImmediate(pump);
  };
  setImmediate(pump);
  return {
    ticks: () => ticks,
    stop: () => {
      running = false;
    },
  };
}

/** Event-loop iterations that elapsed while `work` was in flight — the falsifiable form of "a probe
 *  scheduled while this is running gets to run before it settles" (§27.11 / AC 7). */
export async function ticksDuring(work: () => Promise<unknown>): Promise<number> {
  const ticker = eventLoopTicker();
  const baseline = ticker.ticks();
  await work();
  const elapsed = ticker.ticks() - baseline;
  ticker.stop();
  return elapsed;
}
