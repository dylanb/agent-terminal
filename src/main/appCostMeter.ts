// §27.11

import { formatCost, priceTokens, type CostResult, type ModelTokens } from '../shared/pricing';
import type { PricedTurn, SessionSweep } from './sessionLogSweep';

// flow.ts pushes a null loop only on the transitions that land in `not_started`; completing a flow leaves
// the app loop step entered, so nothing ever retires a finished run. Remove this ceiling and such a run
// re-walks the whole log tree every `sampleDelayMs` for as long as the app stays open.
const MAX_SAMPLE_BACKOFF = 32;

export interface AppCostMeterDeps {
  /** Open a sweep of the repo's session logs over a run window opening at `since` (unbounded when null).
   *  Opening does no I/O; each drain yields the priced turns the window has gained. */
  openSweep: (repoDir: string, since: number | null) => SessionSweep;
  now: () => number;
  /** How long after a figure moves the next sample is taken; a still figure backs off from it. */
  sampleDelayMs: number;
  /** Arm a repo's next cost sample `delayMs` from now, replacing any already armed. */
  armSample: (repoDir: string, delayMs: number, run: () => Promise<void>) => void;
  /** Cancel a repo's armed sample. */
  cancelSample: (repoDir: string) => void;
  /** The reported figure moved, so whatever renders it should re-read. */
  onFigureChanged: () => void;
  /** Record the run's cost into its §25 audit record. Throwing means the record did not land. */
  recordCost: (repoDir: string, cost: CostResult) => void;
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
  const cur = run.byModel.get(turn.model) ?? { model: turn.model, input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
  cur.input += turn.input;
  cur.cacheCreate += turn.cacheCreate;
  cur.cacheRead += turn.cacheRead;
  cur.output += turn.output;
  run.byModel.set(turn.model, cur);
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
    deps.sampleDelayMs * Math.min(2 ** Math.min(idleSamples, 30), MAX_SAMPLE_BACKOFF);

  const sample = async (repoDir: string): Promise<void> => {
    const run = runs.get(repoDir);
    if (!run) return;
    let moved = false;
    try {
      for await (const turn of run.sweep.drain()) {
        if (runs.get(repoDir) !== run) return;
        bank(run, turn);
      }
      const next = priceTokens([...run.byModel.values()].sort((a, b) => a.model.localeCompare(b.model)));
      if (runs.get(repoDir) !== run) return;
      moved = !sameCost(run.cost, next);
      const shown = run.cost === null ? null : formatCost(run.cost);
      if (!sameCost(run.recordedCost, next)) {
        bestEffort('audit record', () => {
          deps.recordCost(repoDir, next);
          run.recordedCost = next;
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
      pushed.set(repoDir, key);
      if (loop === null) {
        runs.delete(repoDir);
        bestEffort('sample cancel', () => deps.cancelSample(repoDir));
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
      });
    },

    current: (repoDir) => runs.get(repoDir)?.cost ?? null,
  };
}
