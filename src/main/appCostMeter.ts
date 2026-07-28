// §27.11

import { auditCost } from '../shared/audit';
import { formatCost, priceTokens, type CostResult } from '../shared/pricing';
import type { SessionSweep } from './sessionLogSweep';
import { MAX_TIMER_DELAY_MS } from './timerBounds';

const SAMPLE_BACKOFF_FACTOR_MAX = 32;

export interface AppCostMeterDeps {
  /** Open a sweep of the repo's session logs over a run window opening at `since` (unbounded when null).
   *  Each drain consumes what those logs have gained and answers the run's per-model totals so far. */
  openSweep: (repoDir: string, since: number | null) => SessionSweep;
  now: () => number;
  /** How long after a figure moves the next sample is taken; a still figure backs off from it. */
  sampleDelayMs: number;
  /** Arm a repo's next cost sample `delayMs` from now, replacing any already armed. */
  armSample: (repoDir: string, delayMs: number, run: () => Promise<void>) => void;
  /** Cancel a repo's armed sample; cancelling a repo with none armed is a no-op. */
  cancelSample: (repoDir: string) => void;
  /** The reported figure moved, so whatever renders it should re-read. */
  onFigureChanged: () => void;
  /** Record the run's cost into its §25 audit record. False means the record did not land, so the meter
   *  re-attempts it on the next sample. */
  recordCost: (repoDir: string, cost: CostResult) => boolean;
  log?: (msg: string, detail?: unknown) => void;
}

export interface AppCostMeter {
  /** The flow's window push: the repo, the selected `app` loop's name (null when §27 is not the engine for
   *  this step), and the run's recorded start (null when the flow records none). Idempotent under repeated
   *  pushes of the same triple; a null loop retires that repo's figure. Never sweeps, never throws. */
  pushWindow(repoDir: string, loop: string | null, startedAt: number | null): void;
  /** The repo's current figure, from memory — never a sweep, never a parse. Null before the first sample. */
  current(repoDir: string): CostResult | null;
}

/** What the run's last §25 record says, in the shape the record itself carries — never the live figure, or
 *  a run discovering ids past the record's own bound would restate a record identical to its predecessor. */
interface RecordedCost {
  shown: string;
  unpriced: string[];
}

interface RunCost {
  startedAt: number | null;
  sweep: SessionSweep;
  cost: CostResult | null;
  shown: string | null;
  recorded: RecordedCost | null;
  idleSamples: number;
  degraded: boolean;
}

function sameList(a: readonly string[] | null, b: readonly string[]): boolean {
  return a !== null && a.length === b.length && a.every((m, i) => m === b[i]);
}

function sameCost(a: CostResult | null, b: CostResult): boolean {
  return a !== null && Object.is(a.usd, b.usd) && sameList(a.unpricedModels, b.unpricedModels);
}

export function createAppCostMeter(deps: AppCostMeterDeps): AppCostMeter {
  const log =
    deps.log ??
    ((m: string, detail?: unknown): void => {
      if (detail === undefined) console.error(m);
      else console.error(m, detail);
    });
  const runs = new Map<string, RunCost>();
  const pushed = new Map<string, string>();

  const bestEffort = (what: string, fn: () => void): void => {
    try {
      fn();
    } catch (e) {
      log(`app cost ${what} failed`, e);
    }
  };

  const delayFor = (idleSamples: number): number =>
    Math.min(deps.sampleDelayMs * Math.min(2 ** idleSamples, SAMPLE_BACKOFF_FACTOR_MAX), MAX_TIMER_DELAY_MS);

  const release = (run: RunCost): void => bestEffort('sweep release', () => run.sweep.close());

  const sampling = new Map<string, Promise<void>>();

  const sample = (repoDir: string): Promise<void> => {
    const already = sampling.get(repoDir);
    if (already) return already;
    const settled = takeSample(repoDir).finally(() => sampling.delete(repoDir));
    sampling.set(repoDir, settled);
    return settled;
  };

  const takeSample = async (repoDir: string): Promise<void> => {
    const run = runs.get(repoDir);
    if (!run) return;
    let moved = false;
    try {
      const totals = await run.sweep.drain();
      if (runs.get(repoDir) !== run) return;
      const next = priceTokens(totals);
      moved = !sameCost(run.cost, next);
      const content = auditCost(next);
      const recordShown = formatCost(content);
      if (run.recorded === null || recordShown !== run.recorded.shown || !sameList(run.recorded.unpriced, content.unpricedModels)) {
        bestEffort('audit record', () => {
          if (deps.recordCost(repoDir, next)) run.recorded = { shown: recordShown, unpriced: content.unpricedModels };
        });
      }
      const rendered = formatCost(next);
      const was = run.shown;
      run.cost = next;
      run.shown = rendered;
      run.degraded = false;
      // WCAG SC 4.1.3
      if (rendered !== was) bestEffort('view-changed signal', () => deps.onFigureChanged());
    } catch (e) {
      if (!run.degraded) log('app cost sample failed', e);
      run.degraded = true;
    }
    if (runs.get(repoDir) !== run) return;
    run.idleSamples = moved ? 0 : run.idleSamples + 1;
    deps.armSample(repoDir, delayFor(run.idleSamples), () => sample(repoDir));
  };

  return {
    pushWindow(repoDir, loop, startedAt) {
      const key = JSON.stringify([loop, startedAt]);
      if (pushed.get(repoDir) === key) return;
      if (loop === null) {
        const retired = runs.get(repoDir);
        runs.delete(repoDir);
        if (retired) release(retired);
        bestEffort('sample cancel', () => {
          deps.cancelSample(repoDir);
          pushed.set(repoDir, key);
        });
        return;
      }
      bestEffort('window push', () => {
        const existing = runs.get(repoDir);
        if (!existing || existing.startedAt !== startedAt) {
          const floor = startedAt === null ? null : Math.min(startedAt, deps.now());
          const sweep = deps.openSweep(repoDir, floor);
          if (existing) {
            runs.delete(repoDir);
            release(existing);
          }
          runs.set(repoDir, {
            startedAt,
            sweep,
            cost: null,
            shown: null,
            recorded: null,
            idleSamples: 0,
            degraded: false,
          });
        }
        deps.armSample(repoDir, deps.sampleDelayMs, () => sample(repoDir));
        pushed.set(repoDir, key);
      });
    },

    current: (repoDir) => runs.get(repoDir)?.cost ?? null,
  };
}
