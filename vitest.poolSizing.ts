/** Local test-runner parallelism cap. Returns the `maxWorkers` to give vitest, or `undefined` to
 *  leave it unrestricted (CI). The percentage rounding mirrors vitest's own `getWorkersCountByPercentage`
 *  for a `'17%'` string — Math.round(fraction*n) clamped to [1, n] — so the two cannot diverge if a
 *  future edit swaps this for the literal string. */
const LOCAL_MAX_WORKERS_FRACTION = 0.17;

export function maxWorkersForEnv(env: { availableParallelism: number; isCI: boolean }): number | undefined {
  if (env.isCI) return undefined;
  const byFraction = Math.round(LOCAL_MAX_WORKERS_FRACTION * env.availableParallelism);
  return Math.max(1, Math.min(env.availableParallelism, byFraction));
}
