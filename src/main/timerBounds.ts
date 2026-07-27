/** Node fires a `setTimeout` whose delay leaves the 32-bit signed range in 1 ms rather than raising. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
