import { beforeEach, describe, expect, it } from 'vitest';
import { createAppCostMeter, type AppCostMeter } from '../../src/main/appCostMeter';
import type { SessionSweep } from '../../src/main/sessionLogSweep';
import { addTokens, sortedTotals, type CostResult, type ModelTokens } from '../../src/shared/pricing';

const REPO = '/repo/one';
const OTHER = '/repo/two';
const FLOOR = 1_000_000;
const LOOP = 'plan-loop';
const BASE_DELAY = 2_000;

/** One billed turn as a log carries it: its per-model tokens and the instant it happened. */
interface LoggedTurn extends ModelTokens {
  at: number;
}

const turn = (opts: { at: number; model?: string; input?: number; output?: number }): LoggedTurn => ({
  at: opts.at,
  model: opts.model ?? 'claude-sonnet-5',
  input: opts.input ?? 0,
  cacheCreate: 0,
  cacheRead: 0,
  output: opts.output ?? 0,
});

/** 1,000,000 claude-sonnet-5 input tokens is exactly $3.00 against the checked-in table. */
const MTOK = 1_000_000;

interface Armed {
  delayMs: number;
  run: () => Promise<void>;
}

interface Harness {
  meter: AppCostMeter;
  /** Fire the armed sample for a repo and wait for it to drain. */
  sample(repoDir?: string): Promise<void>;
  /** Take the armed sample without running it, so a test can interleave a push with it. */
  takeArmed(repoDir?: string): (() => Promise<void>) | undefined;
  /** Whether a sample is armed for a repo. */
  armed(repoDir?: string): boolean;
  /** How far out the currently-armed sample sits. */
  armedDelay(repoDir?: string): number | undefined;
  opened: { repoDir: string; since: number | null }[];
  drains: { repoDir: string }[];
  /** Every sweep released, in order — identified by the window it was opened for, so an assertion can tell
   *  WHICH instance a floor change retired rather than only which repo it belonged to. */
  closed: { repoDir: string; since: number | null }[];
  /** How many times a sample has been armed, counted across replacements the map itself cannot show. */
  arms: number;
  figureChanges: number;
  /** What the meter's own public surface reported for REPO at the instant each view-changed signal fired —
   *  the value a consumer honouring the seam's "re-read" contract synchronously would have seen. */
  figureAtSignal: (CostResult | null)[];
  recorded: { repoDir: string; cost: CostResult }[];
  /** Append billed turns to a repo's logs, as an agent writing them does. */
  append(repoDir: string, turns: LoggedTurn[]): void;
  failSweep(): void;
  healSweep(): void;
  failNextOpen(): void;
  failNextArm(): void;
  failNextRecord(): void;
  /** Everything the meter reported through its injected log seam, newest last. */
  logged: string[];
  now: number;
}

function harness(sampleDelayMs = BASE_DELAY): Harness {
  const logs = new Map<string, LoggedTurn[]>();
  const armedRuns = new Map<string, Armed>();
  let sweepThrows = false;
  let openThrows = false;
  let armThrows = false;
  let recordFails = false;
  const h: Harness = {
    meter: undefined as unknown as AppCostMeter,
    opened: [],
    drains: [],
    closed: [],
    arms: 0,
    figureChanges: 0,
    figureAtSignal: [],
    recorded: [],
    logged: [],
    now: FLOOR + 10_000,
    append: (repoDir, turns) => void logs.set(repoDir, [...(logs.get(repoDir) ?? []), ...turns]),
    failSweep: () => {
      sweepThrows = true;
    },
    healSweep: () => {
      sweepThrows = false;
    },
    failNextOpen: () => {
      openThrows = true;
    },
    failNextArm: () => {
      armThrows = true;
    },
    failNextRecord: () => {
      recordFails = true;
    },
    armed: (repoDir = REPO) => armedRuns.has(repoDir),
    armedDelay: (repoDir = REPO) => armedRuns.get(repoDir)?.delayMs,
    takeArmed: (repoDir = REPO) => {
      const armed = armedRuns.get(repoDir);
      armedRuns.delete(repoDir);
      return armed?.run;
    },
    sample: async (repoDir = REPO) => {
      await h.takeArmed(repoDir)?.();
    },
  };
  h.meter = createAppCostMeter({
    sampleDelayMs,
    // The seam promises each drain consumes what the run's logs GAINED since the last one and answers with
    // the run's per-model totals so far. The fake models a log as the append-only list it is: it folds the
    // entries it has not already folded, and a release drops both the position and the totals.
    openSweep: (repoDir, since): SessionSweep => {
      if (openThrows) {
        openThrows = false;
        throw new Error('log root refused');
      }
      h.opened.push({ repoDir, since });
      let folded = 0;
      let byModel = new Map<string, ModelTokens>();
      let inFlight: Promise<ModelTokens[]> | null = null;
      const walk = async (): Promise<ModelTokens[]> => {
        // The real sweep awaits the filesystem before it folds, so a second caller can arrive while the
        // first is still in flight; without a suspension point here no test could express the overlap.
        await Promise.resolve();
        if (sweepThrows) throw new Error('log root unreadable');
        const content = logs.get(repoDir) ?? [];
        for (const t of content.slice(folded)) {
          if (since === null || t.at >= since) addTokens(byModel, t);
        }
        folded = content.length;
        return sortedTotals(byModel);
      };
      return {
        drain: () => {
          h.drains.push({ repoDir });
          inFlight ??= walk().finally(() => {
            inFlight = null;
          });
          return inFlight;
        },
        close: () => {
          h.closed.push({ repoDir, since });
          folded = 0;
          byModel = new Map();
        },
      };
    },
    now: () => h.now,
    armSample: (repoDir, delayMs, run) => {
      if (armThrows) {
        armThrows = false;
        throw new Error('timer refused');
      }
      h.arms += 1;
      armedRuns.set(repoDir, { delayMs, run });
    },
    cancelSample: (repoDir) => void armedRuns.delete(repoDir),
    onFigureChanged: () => {
      h.figureChanges += 1;
      h.figureAtSignal.push(h.meter.current(REPO));
    },
    recordCost: (repoDir, cost) => {
      if (recordFails) {
        recordFails = false;
        return false;
      }
      h.recorded.push({ repoDir, cost });
      return true;
    },
    log: (msg) => void h.logged.push(msg),
  });
  return h;
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('the §27 run total', () => {
  // AC 1 — the readout covers the WHOLE run: the work turn, every reviewer subagent, the consolidator, the
  // polish conversation and every retry. The sweep is what walks the nested logs; the meter prices whatever
  // totals it is handed into one running figure.
  it('reports the priced dollars of every turn in the window', async () => {
    h.append(REPO, [
      turn({ at: FLOOR + 1, input: MTOK }),
      turn({ at: FLOOR + 2, output: MTOK / 10 }),
      turn({ at: FLOOR + 3, input: MTOK }),
    ]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)).toEqual({ usd: 3 + 1.5 + 3, unpricedModels: [] });
  });

  it('rises when a later sample discovers a further turn, and signals the view changed once per move', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(3);
    expect(h.figureChanges).toBe(1);

    h.append(REPO, [turn({ at: FLOOR + 5, input: MTOK })]);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(6);
    expect(h.figureChanges).toBe(2);

    await h.sample(); // nothing new — the figure did not move
    expect(h.figureChanges).toBe(2);
  });

  it('holds the figure and the record steady across samples that find nothing new', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    for (let i = 0; i < 5; i += 1) {
      await h.sample();
      expect(h.meter.current(REPO)?.usd).toBe(3);
    }
    expect(h.recorded.map((r) => r.cost.usd)).toEqual([3]);
  });

  // AC 2 — the sweep is bounded below by the flow's recorded start.
  it('opens the sweep at the recorded start, so turns logged before it are excluded', async () => {
    h.append(REPO, [turn({ at: FLOOR - 1, input: 100 * MTOK }), turn({ at: FLOOR, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.opened[0]).toEqual({ repoDir: REPO, since: FLOOR });
    expect(h.meter.current(REPO)?.usd).toBe(3);
  });

  // AC 2 — a flow with no recorded start sweeps UNBOUNDED. An unbounded number is wrong; a silent zero
  // hides that it is wrong, so the meter must still report the sweep rather than declining to run.
  it('opens an unbounded sweep when the flow records no start, and never substitutes $0', async () => {
    h.append(REPO, [turn({ at: FLOOR - 500_000, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, null);
    await h.sample();
    expect(h.opened[0]).toEqual({ repoDir: REPO, since: null });
    expect(h.meter.current(REPO)).toEqual({ usd: 3, unpricedModels: [] });
  });

  // A floor after the present survives every field-local check while doing maximum damage. Dropping it
  // switches the window OFF, so the run reports every dollar the repo ever logged as its own — and that
  // number carries no marker, so it is indistinguishable from a run that genuinely spent it. The window IS
  // the limit, so its out-of-range fallback tightens rather than releases (CWE-20/770): a run cannot have
  // started later than now, and turns from now onward still count.
  it('clamps a floor dated in the future to the present rather than sweeping unbounded', async () => {
    h.append(REPO, [turn({ at: h.now - 3_600_000, input: MTOK }), turn({ at: h.now + 1, output: MTOK / 10 })]);
    h.meter.pushWindow(REPO, LOOP, h.now + 3_600_000);
    await h.sample();
    expect(h.opened[0].since).toBe(h.now);
    expect(h.meter.current(REPO)?.usd).toBe(1.5);
  });

  // The clamp is a ceiling, not a replacement: a floor at or before the present is the run's own and is
  // passed through untouched.
  it('passes a floor at or before the present through unchanged', async () => {
    h.meter.pushWindow(REPO, LOOP, h.now - 5_000);
    expect(h.opened[0].since).toBe(h.now - 5_000);

    h.meter.pushWindow(OTHER, LOOP, h.now);
    expect(h.opened[1].since).toBe(h.now);
  });

  // AC 4 — an unpriced model contributes zero dollars and surfaces as `unknown`, never as NaN.
  it('surfaces an unpriced model beside the priced dollars and never yields NaN', async () => {
    h.append(REPO, [
      turn({ at: FLOOR + 1, input: MTOK }),
      turn({ at: FLOOR + 2, model: 'claude-made-up-9', input: MTOK }),
      turn({ at: FLOOR + 3, model: '<synthetic>' }),
    ]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)).toEqual({ usd: 3, unpricedModels: ['claude-made-up-9'] });
    expect(Number.isFinite(h.meter.current(REPO)?.usd)).toBe(true);
  });

  // A model id that names an Object.prototype member resolves through the prototype chain unless the table
  // lookup is own-property gated, and the un-gated lookup prices it to NaN — which no later comparison can
  // ever call equal, so every sample appends another audit record forever.
  it('treats a prototype-named model as unpriced, and records it once rather than on every sample', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, model: 'constructor', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)).toEqual({ usd: 0, unpricedModels: ['constructor'] });

    for (let i = 0; i < 3; i += 1) await h.sample();
    expect(h.recorded).toHaveLength(1);
    expect(h.figureChanges).toBe(1);
  });
});

describe("the §27 meter's activation, retirement and blast radius", () => {
  // AC 10 — a `legacy`-bound step pushes a real floor with NO selected app loop. The meter must stay inert:
  // a rule that samples on any push would run the §27 meter over a §26 run.
  it('never samples for a push carrying no selected app loop', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, null, FLOOR);
    expect(h.armed()).toBe(false);
    await h.sample();
    expect(h.opened).toEqual([]);
    expect(h.drains).toEqual([]);
    expect(h.recorded).toEqual([]);
    expect(h.meter.current(REPO)).toBeNull();
  });

  it('activates on a push naming an app loop even when no window is established', () => {
    h.meter.pushWindow(REPO, LOOP, null);
    expect(h.armed()).toBe(true);
  });

  // A sweep holds a read position per log and the run's accumulated totals; a flow that terminates and a
  // different one that starts must inherit neither, so the retirement releases them rather than dropping
  // the reference and letting a repeated flow switch accumulate them.
  it("retires a repo's figure when the pushed loop goes null, releasing its sweep and stopping the sampling", async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(3);

    h.meter.pushWindow(REPO, null, null);
    expect(h.meter.current(REPO)).toBeNull();
    expect(h.armed()).toBe(false);
    expect(h.closed).toEqual([{ repoDir: REPO, since: FLOOR }]);
  });

  it("leaves a second repo's figure and sweep untouched when the first is retired", async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.append(OTHER, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    h.meter.pushWindow(OTHER, LOOP, FLOOR);
    await h.sample(REPO);
    await h.sample(OTHER);

    h.meter.pushWindow(REPO, null, null);
    expect(h.meter.current(REPO)).toBeNull();
    expect(h.meter.current(OTHER)?.usd).toBe(3);
    expect(h.closed).toEqual([{ repoDir: REPO, since: FLOOR }]);
  });

  // A chain advance leaves the recorded floor untouched, so the run — and its total — continues.
  it('keeps the accumulated figure across a loop-name change on the same floor', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, 'plan-loop', FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(3);

    h.meter.pushWindow(REPO, 'impl-loop', FLOOR);
    expect(h.meter.current(REPO)?.usd).toBe(3);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(3);
    expect(h.opened).toHaveLength(1);
    expect(h.closed).toEqual([]);
  });

  // A restart stamps a NEW floor: that is a new run, and its figure starts from zero rather than carrying
  // the previous run's totals — or its read positions — forward.
  it('releases the old sweep and starts a fresh figure when the recorded floor moves', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(3);

    h.meter.pushWindow(REPO, LOOP, FLOOR + 100);
    expect(h.meter.current(REPO)).toBeNull();
    expect(h.closed).toEqual([{ repoDir: REPO, since: FLOOR }]);
    h.append(REPO, [turn({ at: FLOOR + 101, output: MTOK / 10 })]);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(1.5);
    expect(h.opened).toHaveLength(2);
  });

  // ...and the release is ordered AFTER the replacement is in hand: releasing first and then failing to
  // open the new sweep would destroy a live run's figure over a transient refusal the next push retries.
  it('leaves the run intact when a floor change cannot open its replacement sweep', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(3);

    h.failNextOpen();
    h.meter.pushWindow(REPO, LOOP, FLOOR + 100);
    expect(h.meter.current(REPO)?.usd).toBe(3);
    expect(h.closed).toEqual([]);

    h.meter.pushWindow(REPO, LOOP, FLOOR + 100);
    expect(h.meter.current(REPO)).toBeNull();
    expect(h.closed).toEqual([{ repoDir: REPO, since: FLOOR }]);
  });

  // AC 8a — the flow hydrates on EVERY render and therefore reaches the push, so the seeding read has to be
  // deferred rather than run on it. Neither the push nor the readout may sweep.
  it('sweeps nothing on the push or on the readout — only on the deferred sample', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    for (let i = 0; i < 20; i += 1) {
      h.meter.pushWindow(REPO, LOOP, FLOOR);
      h.meter.current(REPO);
    }
    expect(h.drains).toEqual([]);
    await h.sample();
    expect(h.drains).toHaveLength(1);
    for (let i = 0; i < 20; i += 1) h.meter.current(REPO);
    expect(h.drains).toHaveLength(1);
  });

  // The flow manager forwards every render's push, so the meter is the ONE place the triple is deduped.
  it('re-pushing an unchanged triple neither re-arms a sample nor disturbs the figure', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.armed()).toBe(true); // the sample re-arms itself while the run is open
    await h.sample();
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    expect(h.meter.current(REPO)?.usd).toBe(3);
    expect(h.drains).toHaveLength(2);
    expect(h.opened).toHaveLength(1);
  });

  // The memo that suppresses an unchanged push is what terminates the render↔sample cycle: a sample moves
  // the figure, the strip re-pulls, the re-pull forwards the same triple, and every shadow active↔quiet
  // flip forwards it again. Without the memo each one re-arms at the base delay and a busy turn starves the
  // sample outright, so the memo has to be pinned by something a deletion fails.
  it('arms exactly one sample across a run of identical window pushes', () => {
    for (let i = 0; i < 25; i += 1) h.meter.pushWindow(REPO, LOOP, FLOOR);
    expect(h.arms).toBe(1);
    expect(h.opened).toHaveLength(1);
  });

  // ...and the same memo, committed before the work it suppresses has succeeded, kills the meter outright:
  // flow.ts emits that identical triple on every render for the rest of the run, so every one of them takes
  // the early return and the repo never gets a sweep, a figure or an `app.cost` record again.
  it('retries an identical push after one whose sweep could not be opened', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.failNextOpen();
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    expect(h.armed()).toBe(false);

    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(3);
  });

  it('retries an identical push after one whose sample could not be armed', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.failNextArm();
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    expect(h.armed()).toBe(false);

    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(3);
  });

  // CODE-STANDARDS § delayed consent — a sample scheduled against one run completes later, by which time
  // the run may have been retired. A stale result is inert, never reinterpreted against current state.
  it('drops a sample whose repo was retired while it was in flight', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    const inFlight = h.takeArmed()!();
    h.meter.pushWindow(REPO, null, null);
    await inFlight;
    expect(h.meter.current(REPO)).toBeNull();
    expect(h.recorded).toEqual([]);
  });
});

describe("the §27 sampler's steady state", () => {
  // A run is retired only by a push carrying a null loop, and no flow transition produces one for a
  // COMPLETED run — the invariant `flowCostWindow.test.ts`'s `keeps pushing the app loop after the flow
  // advances to done` holds. Without a backoff the meter therefore re-walks the log tree every two seconds
  // for as long as the app stays open, on the process that also drains the PTY.
  it('backs the sample interval off while the figure sits still', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    expect(h.armedDelay()).toBe(BASE_DELAY);
    await h.sample();
    expect(h.armedDelay()).toBe(BASE_DELAY);

    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      await h.sample();
      delays.push(h.armedDelay()!);
    }
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(delays[delays.length - 1]).toBeGreaterThan(BASE_DELAY);
  });

  // The ceiling is a multiple of the configured cadence, not an absolute duration: an operator who tunes
  // the cadence down (the e2e runs at 200 ms) would otherwise get a steady state hundreds of samples out,
  // and one who tunes it up past the absolute cap would get no backoff at all.
  it('settles the backoff at a fixed multiple of the base interval, whatever that interval is', async () => {
    const settled = async (base: number): Promise<number> => {
      const g = harness(base);
      g.meter.pushWindow(REPO, LOOP, FLOOR);
      for (let i = 0; i < 40; i += 1) await g.sample();
      const reached = g.armedDelay()!;
      for (let i = 0; i < 20; i += 1) await g.sample();
      expect(g.armedDelay()).toBe(reached);
      return reached;
    };
    const fast = await settled(200);
    const slow = await settled(2_000);
    expect(fast).toBeGreaterThan(200);
    expect(slow).toBe(fast * 10);
  });

  // The cadence is an operator-set env value and the backoff multiplies it, so the PRODUCT is what reaches
  // `setTimeout`. Node does not raise past the 32-bit signed range — it fires in 1 ms — turning "sample
  // essentially never" into the tightest whole-tree-sweep loop the code can produce (CWE-400).
  it('never arms a sample further out than a timer can hold, whatever cadence it is configured with', async () => {
    const g = harness(2 ** 31 - 1);
    g.meter.pushWindow(REPO, LOOP, FLOOR);
    for (let i = 0; i < 40; i += 1) {
      expect(g.armedDelay()!).toBeLessThanOrEqual(2 ** 31 - 1);
      expect(g.armedDelay()!).toBeGreaterThan(0);
      await g.sample();
    }
    expect(g.armedDelay()!).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  it('returns to the base interval the moment the figure moves again', async () => {
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    for (let i = 0; i < 4; i += 1) await h.sample();
    expect(h.armedDelay()).toBeGreaterThan(BASE_DELAY);

    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(3);
    expect(h.armedDelay()).toBe(BASE_DELAY);
  });
});

describe('the §27 meter reaching the §25 audit and never damaging the run', () => {
  // AC 5 — the run's cost reaches the audit additively, by value, on each figure-moving sample.
  it("records the run's priced dollars and unpriced ids on each sample that moves the figure", async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK }), turn({ at: FLOOR + 2, model: 'claude-made-up-9', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.recorded).toEqual([{ repoDir: REPO, cost: { usd: 3, unpricedModels: ['claude-made-up-9'] } }]);
    await h.sample();
    expect(h.recorded).toHaveLength(1);

    // The audit record is the ONLY artifact carrying the model ids — the strip renders just the ` +unknown`
    // suffix — so a record gated on the rendered string alone loses every id discovered after the last
    // figure-moving sample, and a fully-unpriced run freezes at the first id it ever saw.
    h.append(REPO, [turn({ at: FLOOR + 3, model: 'claude-made-up-8', input: MTOK })]);
    await h.sample();
    expect(h.recorded).toHaveLength(2);
    expect(h.recorded[1].cost).toEqual({ usd: 3, unpricedModels: ['claude-made-up-8', 'claude-made-up-9'] });
    expect(h.figureChanges).toBe(1);
  });

  // ...and the ids the record carries are BOUNDED, so a run discovering ids past that bound restates
  // nothing: gating on the live list instead appends a record byte-identical to its predecessor, and a
  // reader of an append-only stream is entitled to read a new entry as a change.
  it('appends no record for an unpriced id the record itself would not carry', async () => {
    const gap = (i: number): LoggedTurn => turn({ at: FLOOR + 1 + i, model: `gap-${String(i).padStart(3, '0')}`, input: MTOK });
    h.append(REPO, Array.from({ length: 32 }, (_, i) => gap(i)));
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].cost.unpricedModels).toHaveLength(32);

    h.append(REPO, [gap(32), gap(33), gap(34)]);
    await h.sample();
    expect(h.meter.current(REPO)?.unpricedModels).toHaveLength(35);
    expect(h.recorded).toHaveLength(1);
  });

  // The record and the reported figure are separate commitments: a record the audit refused is re-attempted
  // on the next sample, rather than being suppressed by a memo that says the figure has not moved since.
  it('re-attempts a record the audit refused, at the same figure', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    h.failNextRecord();
    await h.sample();
    expect(h.recorded).toEqual([]);
    expect(h.meter.current(REPO)?.usd).toBe(3);

    await h.sample();
    expect(h.recorded).toEqual([{ repoDir: REPO, cost: { usd: 3, unpricedModels: [] } }]);
    await h.sample();
    expect(h.recorded).toHaveLength(1);
  });

  // WCAG SC 4.1.3 — the seam's contract is "the reported figure moved, so whatever renders it should
  // re-read". A consumer honouring that synchronously must find the new figure already published: signalled
  // first, it re-reads the PREVIOUS figure — null on the first sample, which renders no `.loop-cost` node
  // and no `aria-describedby` at all, so the run's dollars leave both the screen and the accessibility tree
  // until some later sample happens to move the figure again.
  it('publishes the figure before it signals the view changed, so a synchronous re-read sees it', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.figureAtSignal).toEqual([{ usd: 3, unpricedModels: [] }]);

    h.append(REPO, [turn({ at: FLOOR + 2, input: MTOK })]);
    await h.sample();
    expect(h.figureAtSignal).toEqual([
      { usd: 3, unpricedModels: [] },
      { usd: 6, unpricedModels: [] },
    ]);
  });

  // ...and the string the signal is gated on is the one the strip renders — `formatCost` over the meter's
  // own published figure — not the §25 record's bounded copy of it. The two agree only while `formatCost`
  // reads nothing out of `unpricedModels` but its emptiness, which no type, name or test holds.
  it("gates the view-changed signal on the figure it publishes, past the record's own id bound", async () => {
    const drifted = (n: number, at: number): LoggedTurn[] =>
      Array.from({ length: n }, (_, i) => turn({ at: at + i, model: `claude-made-up-${i}`, input: 1 }));
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK }), ...drifted(40, FLOOR + 10)]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    const signalled = h.figureAtSignal.at(-1);
    expect(signalled).toEqual(h.meter.current(REPO));
    expect(signalled?.unpricedModels).toHaveLength(40);
  });

  // The seam documents that a drain begun while one is in flight answers with that one. `pushWindow` arms
  // unconditionally, so a chain advance re-arms while a sample is still awaiting its drain and both bodies
  // run to completion against a single walk — the figure, the §25 series and the backoff must each read as
  // though one sample ran.
  it('settles two overlapping samples for one run as though one had run', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    const first = h.takeArmed();
    h.meter.pushWindow(REPO, 'impl-loop', FLOOR);
    const second = h.takeArmed();
    await Promise.all([first?.(), second?.()]);

    expect(h.meter.current(REPO)?.usd).toBe(3);
    expect(h.recorded).toHaveLength(1);
    expect(h.figureChanges).toBe(1);
    expect(h.armedDelay()).toBe(BASE_DELAY);
  });

  // ...and the coalescing is scoped to the RUN, not the repo. A floor change replaces the run while the
  // previous run's sample is still draining; that sample returns early at its own identity check WITHOUT
  // re-arming, because the replacement got its own arm from the push. Coalescing per repo would hand the
  // replacement's arm the retired run's promise, so the new run would never sample and never re-arm —
  // its figure would stay null for the life of the run.
  it('samples the replacement run when a floor change lands while the previous sample is draining', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    const draining = h.takeArmed()?.();

    h.meter.pushWindow(REPO, LOOP, FLOOR + 100);
    h.append(REPO, [turn({ at: FLOOR + 101, output: MTOK / 10 })]);
    await Promise.all([draining, h.takeArmed()?.()]);

    expect(h.meter.current(REPO)?.usd).toBe(1.5);
    expect(h.armed()).toBe(true);
  });

  // The per-id LENGTH bound is the half the count bound cannot show: an over-long id records once and the
  // memo that decides whether a restatement would say anything new compares the same bounded string back,
  // so the following samples append nothing.
  it('records an over-long model id once and does not restate it on the samples after', async () => {
    const hostile = `claude-made-up-${'x'.repeat(500)}`;
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK }), turn({ at: FLOOR + 2, model: hostile, input: 10 })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.recorded).toHaveLength(1);

    await h.sample();
    await h.sample();
    expect(h.recorded).toHaveLength(1);
  });

  // WCAG SC 4.1.3 — the readout rides a polite live region, so a repaint is an announcement. A move too
  // small to change the rendered figure has nothing to announce and must not push one; the §25 append is
  // gated on the SAME rendered figure, so the record cannot restate a total the UI refused to paint.
  it('signals the view only when the RENDERED figure changes, not on a sub-cent move', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.figureChanges).toBe(1);

    h.append(REPO, [turn({ at: FLOOR + 2, input: 1000 })]);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBeCloseTo(3.003, 6);
    expect(h.figureChanges).toBe(1);
    // The record is gated on the same rendered figure the repaint is: an `Object.is` on the raw dollars
    // appends a §25 document for every tick the UI deliberately refuses to repaint, making a run-total
    // restatement the only timer-driven member of an otherwise event-driven vocabulary (CWE-770).
    expect(h.recorded).toHaveLength(1);

    h.append(REPO, [turn({ at: FLOOR + 3, input: MTOK })]);
    await h.sample();
    expect(h.figureChanges).toBe(2);
    expect(h.recorded).toHaveLength(2);
    expect(h.recorded[1].cost.usd).toBeCloseTo(6.003, 6);
  });

  // AC 7 — the meter keeps sampling through an outage, so a permanent one (a `<session-uuid>/subagents/`
  // left root-owned by a Claude Code run under sudo) otherwise emits one line per sample for the life of
  // the app while the readout stays at the same `null` that means "no figure yet" (CWE-703/755).
  it('names a sweep that stopped working once per outage, not once per sample', async () => {
    h.append(REPO, [turn({ at: FLOOR + 1, input: MTOK })]);
    h.failSweep();
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    for (let i = 0; i < 3; i += 1) await h.sample();
    expect(h.logged).toHaveLength(1);
    expect(h.meter.current(REPO)).toBeNull();

    h.healSweep();
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(3);
    expect(h.logged).toHaveLength(1);

    h.failSweep();
    for (let i = 0; i < 3; i += 1) await h.sample();
    expect(h.logged).toHaveLength(2);
  });

  // AC 7 — the meter is display-only. A run whose cost cannot be computed AT ALL completes exactly as one
  // that priced cleanly: nothing here may throw into the flow path, and an unreadable log root leaves the
  // readout ABSENT rather than asserting a confident $0.00 for a run that spent money.
  it('swallows a sweep that fails outright, reports no figure, and keeps sampling', async () => {
    h.failSweep();
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await expect(h.sample()).resolves.toBeUndefined();
    expect(h.meter.current(REPO)).toBeNull();
    expect(h.recorded).toEqual([]);
    expect(h.armed()).toBe(true);
  });

  it('swallows a throwing audit recorder and a throwing view-changed signal', async () => {
    let armed: (() => Promise<void>) | null = null;
    const meter = createAppCostMeter({
      sampleDelayMs: BASE_DELAY,
      openSweep: () => ({
        drain: async () => [{ model: 'claude-sonnet-5', input: MTOK, cacheCreate: 0, cacheRead: 0, output: 0 }],
        close: () => {},
      }),
      now: () => FLOOR + 10_000,
      armSample: (_repoDir, _delayMs, run) => {
        armed = run;
      },
      cancelSample: () => {},
      onFigureChanged: () => {
        throw new Error('renderer gone');
      },
      recordCost: () => {
        throw new Error('audit closed');
      },
      log: () => {},
    });
    meter.pushWindow(REPO, LOOP, FLOOR);
    await expect((armed as unknown as () => Promise<void>)()).resolves.toBeUndefined();
    expect(meter.current(REPO)?.usd).toBe(3);
  });

  it('never throws out of the push itself, even when opening or releasing the sweep fails', () => {
    expect(() => h.meter.pushWindow(REPO, LOOP, Number.NaN)).not.toThrow();
    expect(() => h.meter.pushWindow(REPO, null, null)).not.toThrow();

    const refusing = createAppCostMeter({
      sampleDelayMs: BASE_DELAY,
      openSweep: () => {
        throw new Error('log root refused');
      },
      now: () => FLOOR,
      armSample: () => {},
      cancelSample: () => {},
      onFigureChanged: () => {},
      recordCost: () => true,
      log: () => {},
    });
    expect(() => refusing.pushWindow(REPO, LOOP, FLOOR)).not.toThrow();
    expect(refusing.current(REPO)).toBeNull();

    const unreleasable = createAppCostMeter({
      sampleDelayMs: BASE_DELAY,
      openSweep: () => ({
        drain: async () => [],
        close: () => {
          throw new Error('release failed');
        },
      }),
      now: () => FLOOR,
      armSample: () => {},
      cancelSample: () => {},
      onFigureChanged: () => {},
      recordCost: () => true,
      log: () => {},
    });
    unreleasable.pushWindow(REPO, LOOP, FLOOR);
    expect(() => unreleasable.pushWindow(REPO, null, null)).not.toThrow();
    expect(unreleasable.current(REPO)).toBeNull();
  });
});
