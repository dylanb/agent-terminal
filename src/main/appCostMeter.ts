// §27.11

import { addTokens, formatCost, priceTokens, sortedTotals, type CostResult, type ModelTokens } from '../shared/pricing';
import type { PricedTurn, SessionSweep } from './sessionLogSweep';

// No push retires a COMPLETED run: `done` leaves the app loop step entered, so a finished run keeps
// sampling for as long as the app stays open, and only this ceiling bounds how often.
const SAMPLE_BACKOFF_FACTOR_MAX = 32;

export interface AppCostMeterDeps {
  /** Open a sweep of the repo's session logs over a run window opening at `since` (unbounded when null).
   *  Each drain re-yields every turn in the window from any log that changed, so the caller must bank the
   *  identities it has already counted rather than assume the drains are disjoint. */
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
  log?: (msg: string, err: unknown) => void;
}

export interface AppCostMeter {
  /** The flow's window push: the repo, the selected `app` loop's name (null when §27 is not the engine for
   *  this step), and the run's recorded start (null when the flow records none). Idempotent under repeated
   *  pushes of the same triple; a null loop retires that repo's figure. Never sweeps, never throws. */
  pushWindow(repoDir: string, loop: string | null, startedAt: number | null): void;
  /** The repo's current figure, from memory — never a sweep, never a parse. Null before the first sample. */
  current(repoDir: string): CostResult | null;
}

interface RunCost {
  startedAt: number | null;
  sweep: SessionSweep;
  banked: Set<string>;
  byModel: Map<string, ModelTokens>;
  cost: CostResult | null;
  recordedCost: CostResult | null;
  idleSamples: number;
}

function bank(run: RunCost, turn: PricedTurn): void {
  if (run.banked.has(turn.id)) return;
  run.banked.add(turn.id);
  addTokens(run.byModel, turn);
}

function sameCost(a: CostResult | null, b: CostResult): boolean {
  return (
    a !== null &&
    Object.is(a.usd, b.usd) &&
    a.unpricedModels.length === b.unpricedModels.length &&
    a.unpricedModels.every((m, i) => m === b.unpricedModels[i])
  );
}

export function createAppCostMeter(deps: AppCostMeterDeps): AppCostMeter {
  const log = deps.log ?? ((m, e): void => console.error(m, e));
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
    deps.sampleDelayMs * Math.min(2 ** idleSamples, SAMPLE_BACKOFF_FACTOR_MAX);

  const sample = async (repoDir: string): Promise<void> => {
    const run = runs.get(repoDir);
    if (!run) return;
    let moved = false;
    try {
      for await (const turn of run.sweep.drain()) {
        if (runs.get(repoDir) !== run) return;
        bank(run, turn);
      }
      const next = priceTokens(sortedTotals(run.byModel));
      if (runs.get(repoDir) !== run) return;
      moved = !sameCost(run.cost, next);
      const shown = run.cost === null ? null : formatCost(run.cost);
      if (!sameCost(run.recordedCost, next)) {
        bestEffort('audit record', () => {
          if (deps.recordCost(repoDir, next)) run.recordedCost = next;
        });
      }
      run.cost = next;
      // WCAG SC 2.2.2 / 4.1.3
      if (shown !== formatCost(next)) bestEffort('view-changed signal', () => deps.onFigureChanged());
    } catch (e) {
      log('app cost sample failed', e);
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
            recordedCost: null,
            idleSamples: 0,
          });
        }
        deps.armSample(repoDir, deps.sampleDelayMs, () => sample(repoDir));
        pushed.set(repoDir, key);
      });
    },

    current: (repoDir) => runs.get(repoDir)?.cost ?? null,
  };
}
