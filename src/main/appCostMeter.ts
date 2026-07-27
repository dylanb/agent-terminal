// §27.11

import { addTokens, formatCost, priceTokens, sortedTotals, type CostResult, type ModelTokens } from '../shared/pricing';
import type { PricedTurn, SessionSweep } from './sessionLogSweep';
import { MAX_TIMER_DELAY_MS } from './timerBounds';

export const SAMPLE_BACKOFF_FACTOR_MAX = 32;
/** CWE-770 */
export const MAX_BANKED_MODELS = 256;

/** A run's figure together with whether its retention ceiling stopped that figure growing (§27.11). */
export interface AppRunCost {
  cost: CostResult;
  capped: boolean;
}

/** An `AppRunCost` as the §27 loop-view read-out shows it: a capped run's dollars are a floor the run has
 *  already passed, so the figure is marked rather than presented as the run's total. */
export function renderCost(run: AppRunCost): string {
  return run.capped ? `${formatCost(run.cost)} +uncounted` : formatCost(run.cost);
}

export interface AppCostMeterDeps {
  /** Open a sweep of the repo's session logs over a run window opening at `since` (unbounded when null).
   *  Each drain re-yields every turn in the window from any log that changed, so the caller must bank the
   *  identities it has already counted rather than assume the drains are disjoint. */
  openSweep: (repoDir: string, since: number | null) => SessionSweep;
  now: () => number;
  /** How long after a figure moves the next sample is taken; a still figure backs off from it. */
  sampleDelayMs: number;
  /** Most distinct billed-turn identities one run retains before it stops admitting new ones (CWE-770). */
  maxBankedTurns: number;
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
  current(repoDir: string): AppRunCost | null;
}

interface RunCost {
  startedAt: number | null;
  sweep: SessionSweep;
  banked: Set<string>;
  byModel: Map<string, ModelTokens>;
  cost: CostResult | null;
  recordedShown: string | null;
  recordedUnpriced: string[] | null;
  idleSamples: number;
  degraded: boolean;
  capped: boolean;
}

function bank(run: RunCost, turn: PricedTurn, maxBankedTurns: number): void {
  if (run.banked.has(turn.id)) return;
  if (run.banked.size >= maxBankedTurns || (!run.byModel.has(turn.model) && run.byModel.size >= MAX_BANKED_MODELS)) {
    run.capped = true;
    return;
  }
  run.banked.add(turn.id);
  addTokens(run.byModel, turn);
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

  const sample = async (repoDir: string): Promise<void> => {
    const run = runs.get(repoDir);
    if (!run) return;
    let moved = false;
    try {
      const wasCapped = run.capped;
      for await (const turn of run.sweep.drain()) {
        if (runs.get(repoDir) !== run) return;
        bank(run, turn, deps.maxBankedTurns);
      }
      if (run.capped && !wasCapped) log('app cost stopped admitting turns at its retention ceiling');
      const next = priceTokens(sortedTotals(run.byModel));
      if (runs.get(repoDir) !== run) return;
      moved = !sameCost(run.cost, next);
      const rendered = renderCost({ cost: next, capped: run.capped });
      const wasShown = run.cost === null ? null : renderCost({ cost: run.cost, capped: wasCapped });
      if (rendered !== run.recordedShown || !sameList(run.recordedUnpriced, next.unpricedModels)) {
        bestEffort('audit record', () => {
          if (deps.recordCost(repoDir, next)) {
            run.recordedShown = rendered;
            run.recordedUnpriced = next.unpricedModels;
          }
        });
      }
      run.cost = next;
      run.degraded = false;
      // WCAG SC 4.1.3
      if (rendered !== wasShown) bestEffort('view-changed signal', () => deps.onFigureChanged());
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
        runs.delete(repoDir);
        bestEffort('sample cancel', () => {
          deps.cancelSample(repoDir);
          pushed.set(repoDir, key);
        });
        return;
      }
      bestEffort('window push', () => {
        const existing = runs.get(repoDir);
        if (!existing || existing.startedAt !== startedAt) {
          const floor = startedAt !== null && startedAt <= deps.now() ? startedAt : null;
          runs.set(repoDir, {
            startedAt,
            sweep: deps.openSweep(repoDir, floor),
            banked: new Set(),
            byModel: new Map(),
            cost: null,
            recordedShown: null,
            recordedUnpriced: null,
            idleSamples: 0,
            degraded: false,
            capped: false,
          });
        }
        deps.armSample(repoDir, deps.sampleDelayMs, () => sample(repoDir));
        pushed.set(repoDir, key);
      });
    },

    current: (repoDir) => {
      const run = runs.get(repoDir);
      return run === undefined || run.cost === null ? null : { cost: run.cost, capped: run.capped };
    },
  };
}
