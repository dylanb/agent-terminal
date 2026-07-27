import { beforeEach, describe, expect, it } from 'vitest';
import { createAppCostMeter, MAX_BANKED_MODELS, renderCost, type AppCostMeter } from '../../src/main/appCostMeter';
import { finiteInstant, type PricedTurn, type SessionSweep } from '../../src/main/sessionLogSweep';
import type { CostResult } from '../../src/shared/pricing';

const REPO = '/repo/one';
const OTHER = '/repo/two';
const FLOOR = 1_000_000;
const LOOP = 'plan-loop';
const BASE_DELAY = 2_000;
const BANKED_CEILING = 512;

const turn = (opts: {
  at: number;
  id: string;
  model?: string;
  input?: number;
  output?: number;
}): PricedTurn => ({
  at: finiteInstant(opts.at)!,
  id: opts.id,
  model: opts.model ?? 'claude-sonnet-5',
  input: opts.input ?? 0,
  cacheCreate: 0,
  cacheRead: 0,
  output: opts.output ?? 0,
});

/** 1,000,000 claude-sonnet-5 input tokens is exactly $3.00 against the checked-in table. */
const MTOK = 1_000_000;

/** `count` distinctly-identified billed turns, one per instant, each cheap enough that the ceiling rather
 *  than the arithmetic is what the assertion reads. */
const spread = (count: number): PricedTurn[] =>
  Array.from({ length: count }, (_, i) => turn({ at: FLOOR + 1 + i, id: `t${i}`, input: 1000 }));

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
  /** How many times a sample has been armed, counted across replacements the map itself cannot show. */
  arms: number;
  figureChanges: number;
  recorded: { repoDir: string; cost: CostResult }[];
  setLogs(repoDir: string, turns: PricedTurn[]): void;
  failSweep(): void;
  healSweep(): void;
  failNextOpen(): void;
  failNextArm(): void;
  failNextRecord(): void;
  /** Everything the meter reported through its injected log seam, newest last. */
  logged: string[];
  now: number;
}

function harness(sampleDelayMs = BASE_DELAY, maxBankedTurns = BANKED_CEILING): Harness {
  const logs = new Map<string, PricedTurn[]>();
  const armedRuns = new Map<string, Armed>();
  let sweepThrows = false;
  let openThrows = false;
  let armThrows = false;
  let recordFails = false;
  const h: Harness = {
    meter: undefined as unknown as AppCostMeter,
    opened: [],
    drains: [],
    arms: 0,
    figureChanges: 0,
    recorded: [],
    logged: [],
    now: FLOOR + 10_000,
    setLogs: (repoDir, turns) => void logs.set(repoDir, turns),
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
    maxBankedTurns,
    openSweep: (repoDir, since): SessionSweep => {
      if (openThrows) {
        openThrows = false;
        throw new Error('log root refused');
      }
      h.opened.push({ repoDir, since });
      // The seam promises each drain yields every turn in the window the sweep has not already yielded
      // from an UNCHANGED log — the first drain yields the whole window, and a log that grew is re-yielded
      // whole. The fake models a log's content by the array it was set from: the same array is the
      // unchanged log (nothing to yield), a new one is the grown log (everything again).
      let drained: PricedTurn[] | null = null;
      return {
        drain: () => {
          h.drains.push({ repoDir });
          const content = logs.get(repoDir) ?? [];
          const fresh = content === drained ? [] : content;
          const scripted = fresh.filter((t) => Number.isFinite(t.at) && (since === null || t.at >= since));
          return {
            async *[Symbol.asyncIterator]() {
              if (sweepThrows) throw new Error('log root unreadable');
              for (const t of scripted) yield t;
              drained = content;
            },
          };
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
  // polish conversation and every retry. The sweep is what walks the nested logs; the meter accumulates
  // every turn it is handed into one running figure.
  it('accumulates every priced turn in the window into one running total', async () => {
    h.setLogs(REPO, [
      turn({ at: FLOOR + 1, id: 'work', input: MTOK }),
      turn({ at: FLOOR + 2, id: 'reviewer', output: MTOK / 10 }),
      turn({ at: FLOOR + 3, id: 'consolidator', input: MTOK }),
    ]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.cost).toEqual({ usd: 3 + 1.5 + 3, unpricedModels: [] });
  });

  it('rises when a later sample discovers a further turn, and signals the view changed once per move', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);
    expect(h.figureChanges).toBe(1);

    h.setLogs(REPO, [
      turn({ at: FLOOR + 1, id: 'work', input: MTOK }),
      turn({ at: FLOOR + 5, id: 'retry', input: MTOK }),
    ]);
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBe(6);
    expect(h.figureChanges).toBe(2);

    await h.sample(); // nothing new — the figure did not move
    expect(h.figureChanges).toBe(2);
  });

  // The run's accumulator outlives every sample while the log the run is writing grows under it, so the
  // sweep re-yields that log whole on each pass. A turn re-read that way must not be added twice: with the
  // identity total, the same three-dollar turn read on twenty passes is three dollars, not sixty.
  it('holds the figure steady while an unchanged window is re-read, and adds only what a grown log gained', async () => {
    const work = turn({ at: FLOOR + 1, id: 'work', input: MTOK });
    h.setLogs(REPO, [work]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    for (let i = 0; i < 5; i += 1) {
      h.setLogs(REPO, [work]); // a fresh array: the log's mtime moved, so it is re-read whole
      await h.sample();
      expect(h.meter.current(REPO)?.cost.usd).toBe(3);
    }
    h.setLogs(REPO, [work, turn({ at: FLOOR + 2, id: 'polish', input: MTOK })]);
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBe(6);
    expect(h.recorded.map((r) => r.cost.usd)).toEqual([3, 6]);
  });

  // The sweep gives a turn the log stamps no billing identity on a position-derived one, stable across
  // drains of the same log. Two such turns are two dollars-worth of distinct spend; the SAME one re-read is
  // not. A meter that banked only identified turns ratcheted the run's figure upward with no new spend.
  it('counts each turn carrying no billing identity once, however many drains re-read its log', async () => {
    const first = turn({ at: FLOOR + 1, id: '["/logs/session.jsonl",1]', input: MTOK });
    const second = turn({ at: FLOOR + 2, id: '["/logs/session.jsonl",2]', input: MTOK });
    h.setLogs(REPO, [first, second]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBe(6);

    for (let i = 0; i < 3; i += 1) {
      h.setLogs(REPO, [first, second]);
      await h.sample();
      expect(h.meter.current(REPO)?.cost.usd).toBe(6);
    }
    expect(h.recorded).toHaveLength(1);
  });

  // AC 2 — the sweep is bounded below by the flow's recorded start.
  it('sweeps from the recorded start, so turns logged before it are excluded', async () => {
    h.setLogs(REPO, [
      turn({ at: FLOOR - 1, id: 'before', input: 100 * MTOK }),
      turn({ at: FLOOR, id: 'at-floor', input: MTOK }),
    ]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.opened[0]).toEqual({ repoDir: REPO, since: FLOOR });
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);
  });

  // AC 2 — a flow with no recorded start sweeps UNBOUNDED. An unbounded number is wrong; a silent zero
  // hides that it is wrong, so the meter must still report the sweep rather than declining to run.
  it('sweeps unbounded when the flow records no start, and never substitutes $0', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR - 500_000, id: 'ancient', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, null);
    await h.sample();
    expect(h.opened[0]).toEqual({ repoDir: REPO, since: null });
    expect(h.meter.current(REPO)?.cost).toEqual({ usd: 3, unpricedModels: [] });
  });

  // A floor after the present survives every field-local check while doing maximum damage: the pre-filter
  // then excludes every log and the strip reads $0.00 for a run that spent money. Clamping to no-floor
  // lands on the unbounded sweep — a wrong-but-loud number rather than a silent zero.
  it('clamps a floor dated in the future to no recorded floor rather than filtering every log away', async () => {
    h.setLogs(REPO, [turn({ at: h.now - 1000, id: 'real', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, h.now + 3_600_000);
    await h.sample();
    expect(h.opened[0].since).toBeNull();
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);
  });

  // AC 3 — a billed turn counts once. A resumed or forked session replays prior turns verbatim, so the same
  // billing identity arrives again from a different file, at a later log time and in a different position.
  it('banks a billing identity once, across samples and within one sample', async () => {
    h.setLogs(REPO, [
      turn({ at: FLOOR + 1, id: 'work', input: MTOK }),
      turn({ at: FLOOR + 1, id: 'work', input: MTOK }),
    ]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);

    h.setLogs(REPO, [
      turn({ at: FLOOR + 9, id: 'work', input: MTOK }),
      turn({ at: FLOOR + 1, id: 'work', input: MTOK }),
    ]);
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);
  });

  // AC 4 — an unpriced model contributes zero dollars and surfaces as `unknown`, never as NaN.
  it('surfaces an unpriced model beside the priced dollars and never yields NaN', async () => {
    h.setLogs(REPO, [
      turn({ at: FLOOR + 1, id: 'priced', input: MTOK }),
      turn({ at: FLOOR + 2, id: 'unpriced', model: 'claude-made-up-9', input: MTOK }),
      turn({ at: FLOOR + 3, id: 'synthetic', model: '<synthetic>' }),
    ]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    const cost = h.meter.current(REPO)?.cost;
    expect(cost).toEqual({ usd: 3, unpricedModels: ['claude-made-up-9'] });
    expect(Number.isFinite(cost?.usd)).toBe(true);
  });

  // A model id that names an Object.prototype member resolves through the prototype chain unless the table
  // lookup is own-property gated, and the un-gated lookup prices it to NaN — which no later comparison can
  // ever call equal, so every sample appends another audit record forever.
  it('treats a prototype-named model as unpriced, and records it once rather than on every sample', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'hostile', model: 'constructor', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.cost).toEqual({ usd: 0, unpricedModels: ['constructor'] });

    for (let i = 0; i < 3; i += 1) {
      h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'hostile', model: 'constructor', input: MTOK })]);
      await h.sample();
    }
    expect(h.recorded).toHaveLength(1);
    expect(h.figureChanges).toBe(1);
  });
});

describe('the §27 meter`s activation, retirement and blast radius', () => {
  // AC 10 — a `legacy`-bound step pushes a real floor with NO selected app loop. The meter must stay inert:
  // a rule that samples on any push would run the §27 meter over a §26 run.
  it('never samples for a push carrying no selected app loop', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
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

  it('retires a repo`s figure when the pushed loop goes null, and stops sampling it', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);

    h.meter.pushWindow(REPO, null, null);
    expect(h.meter.current(REPO)).toBeNull();
    expect(h.armed()).toBe(false);
  });

  it('leaves a second repo`s figure untouched when the first is retired', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'a', input: MTOK })]);
    h.setLogs(OTHER, [turn({ at: FLOOR + 1, id: 'b', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    h.meter.pushWindow(OTHER, LOOP, FLOOR);
    await h.sample(REPO);
    await h.sample(OTHER);

    h.meter.pushWindow(REPO, null, null);
    expect(h.meter.current(REPO)).toBeNull();
    expect(h.meter.current(OTHER)?.cost.usd).toBe(3);
  });

  // A chain advance leaves the recorded floor untouched, so the run — and its total — continues.
  it('keeps the accumulated figure across a loop-name change on the same floor', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    h.meter.pushWindow(REPO, 'plan-loop', FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);

    h.meter.pushWindow(REPO, 'impl-loop', FLOOR);
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);
    expect(h.opened).toHaveLength(1);
  });

  // A restart stamps a NEW floor: that is a new run, and its figure starts from zero rather than carrying
  // the previous run's banked turns forward.
  it('starts a fresh figure when the recorded floor moves', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);

    h.meter.pushWindow(REPO, LOOP, FLOOR + 100);
    expect(h.meter.current(REPO)).toBeNull();
    h.setLogs(REPO, [turn({ at: FLOOR + 101, id: 'fresh', output: MTOK / 10 })]);
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBe(1.5);
    expect(h.opened).toHaveLength(2);
  });

  // AC 8a — the flow hydrates on EVERY render and therefore reaches the push, so the seeding read has to be
  // deferred rather than run on it. Neither the push nor the readout may sweep.
  it('sweeps nothing on the push or on the readout — only on the deferred sample', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
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
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.armed()).toBe(true); // the sample re-arms itself while the run is open
    await h.sample();
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);
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
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    h.failNextOpen();
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    expect(h.armed()).toBe(false);

    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);
  });

  it('retries an identical push after one whose sample could not be armed', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    h.failNextArm();
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    expect(h.armed()).toBe(false);

    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);
  });

  // CODE-STANDARDS § delayed consent — a sample scheduled against one run completes later, by which time
  // the ledger may have been retired. A stale result is inert, never reinterpreted against current state.
  it('drops a sample whose repo was retired while it was in flight', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    const inFlight = h.takeArmed()!();
    h.meter.pushWindow(REPO, null, null);
    await inFlight;
    expect(h.meter.current(REPO)).toBeNull();
    expect(h.recorded).toEqual([]);
  });
});

describe('the §27 sampler`s steady state', () => {
  // A run is retired only by a push carrying a null loop, and no flow transition produces one for a
  // COMPLETED run — the invariant `flowCostWindow.test.ts`'s `keeps pushing the app loop after the flow
  // advances to done` holds. Without a backoff the meter therefore re-walks the log tree every two seconds
  // for as long as the app stays open, on the process that also drains the PTY.
  it('backs the sample interval off while the figure sits still', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
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

    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'polish', input: MTOK })]);
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);
    expect(h.armedDelay()).toBe(BASE_DELAY);
  });
});

describe('the §27 meter reaching the §25 audit and never damaging the run', () => {
  // AC 5 — the run's cost reaches the audit additively, by value, on each figure-moving sample.
  it('records the run`s priced dollars and unpriced ids on each sample that moves the figure', async () => {
    h.setLogs(REPO, [
      turn({ at: FLOOR + 1, id: 'work', input: MTOK }),
      turn({ at: FLOOR + 2, id: 'gap', model: 'claude-made-up-9', input: MTOK }),
    ]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.recorded).toEqual([{ repoDir: REPO, cost: { usd: 3, unpricedModels: ['claude-made-up-9'] } }]);
    await h.sample();
    expect(h.recorded).toHaveLength(1);

    // The audit record is the ONLY artifact carrying the model ids — the strip renders just the ` +unknown`
    // suffix — so a record gated on the rendered string loses every id discovered after the last
    // figure-moving sample, and a fully-unpriced run freezes at the first id it ever saw.
    h.setLogs(REPO, [
      turn({ at: FLOOR + 1, id: 'work', input: MTOK }),
      turn({ at: FLOOR + 2, id: 'gap', model: 'claude-made-up-9', input: MTOK }),
      turn({ at: FLOOR + 3, id: 'gap-two', model: 'claude-made-up-8', input: MTOK }),
    ]);
    await h.sample();
    expect(h.recorded).toHaveLength(2);
    expect(h.recorded[1].cost).toEqual({ usd: 3, unpricedModels: ['claude-made-up-8', 'claude-made-up-9'] });
    expect(h.figureChanges).toBe(1);
  });

  // The record and the reported figure are separate commitments: a record the audit refused is re-attempted
  // on the next sample, rather than being suppressed by a memo that says the figure has not moved since.
  it('re-attempts a record the audit refused, at the same figure', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    h.failNextRecord();
    await h.sample();
    expect(h.recorded).toEqual([]);
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);

    await h.sample();
    expect(h.recorded).toEqual([{ repoDir: REPO, cost: { usd: 3, unpricedModels: [] } }]);
    await h.sample();
    expect(h.recorded).toHaveLength(1);
  });

  // WCAG SC 4.1.3 — the readout rides a polite live region, so a repaint is an announcement. A move too
  // small to change the rendered figure has nothing to announce and must not push one; the §25 append is
  // gated on the SAME rendered figure, so the record cannot restate a total the UI refused to paint.
  it('signals the view only when the RENDERED figure changes, not on a sub-cent move', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.figureChanges).toBe(1);

    h.setLogs(REPO, [
      turn({ at: FLOOR + 1, id: 'work', input: MTOK }),
      turn({ at: FLOOR + 2, id: 'crumb', input: 1000 }),
    ]);
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBeCloseTo(3.003, 6);
    expect(h.figureChanges).toBe(1);
    // The record is gated on the same rendered figure the repaint is: an `Object.is` on the raw dollars
    // appends a §25 document for every tick the UI deliberately refuses to repaint, making a run-total
    // restatement the only timer-driven member of an otherwise event-driven vocabulary (CWE-770).
    expect(h.recorded).toHaveLength(1);

    h.setLogs(REPO, [
      turn({ at: FLOOR + 1, id: 'work', input: MTOK }),
      turn({ at: FLOOR + 2, id: 'crumb', input: 1000 }),
      turn({ at: FLOOR + 3, id: 'retry', input: MTOK }),
    ]);
    await h.sample();
    expect(h.figureChanges).toBe(2);
    expect(h.recorded).toHaveLength(2);
    expect(h.recorded[1].cost.usd).toBeCloseTo(6.003, 6);
  });

  // AC 7 — the meter keeps sampling through an outage, so a permanent one (a `<session-uuid>/subagents/`
  // left root-owned by a Claude Code run under sudo) otherwise emits one line per sample for the life of
  // the app while the readout stays at the same `null` that means "no figure yet" (CWE-703/755).
  it('names a sweep that stopped working once per outage, not once per sample', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    h.failSweep();
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    for (let i = 0; i < 3; i += 1) await h.sample();
    expect(h.logged).toHaveLength(1);
    expect(h.meter.current(REPO)).toBeNull();

    h.healSweep();
    await h.sample();
    expect(h.meter.current(REPO)?.cost.usd).toBe(3);
    expect(h.logged).toHaveLength(1);

    h.failSweep();
    for (let i = 0; i < 3; i += 1) await h.sample();
    expect(h.logged).toHaveLength(2);
  });

  // CWE-770 — the run's identity set and its per-model table are keyed on Claude Code's private log
  // content and are released only by a `loop === null` push, which a completed run never produces. The
  // worst case is the branch AC 2 requires: with no usable recorded start the sweep is unbounded, so the
  // repo's ENTIRE Claude Code history is banked and held for as long as the app stays open.
  it('stops admitting new turn identities past its ceiling, leaving the figure finite and still reported', async () => {
    h.setLogs(REPO, spread(BANKED_CEILING));
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    const atCeiling = h.meter.current(REPO)!.cost.usd;
    expect(atCeiling).toBeGreaterThan(0);

    h.setLogs(REPO, spread(BANKED_CEILING + 50));
    await h.sample();
    expect(h.meter.current(REPO)!.cost.usd).toBe(atCeiling);
  });

  // A refused admission drops billed dollars the run really spent, so the figure is a FLOOR — and once the
  // ceiling is reached nothing moves it again, so the run's last word is a wrong number rendered with the
  // same confidence as a right one (CWE-682/CWE-755). Two runs reporting identical dollars, one of which
  // stopped counting, must not be indistinguishable to whatever renders them.
  it('reports a run whose retention ceiling was reached as a floor, not as a total', async () => {
    h.setLogs(REPO, spread(BANKED_CEILING + 1));
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    const capped = h.meter.current(REPO)!;
    expect(capped.capped).toBe(true);
    expect(renderCost(capped)).toBe(`${'$' + capped.cost.usd.toFixed(2)} +uncounted`);

    h.setLogs(OTHER, spread(BANKED_CEILING));
    h.meter.pushWindow(OTHER, LOOP, FLOOR);
    await h.sample(OTHER);
    const whole = h.meter.current(OTHER)!;
    expect(whole.capped).toBe(false);
    expect(renderCost(whole)).toBe('$' + whole.cost.usd.toFixed(2));
    expect(renderCost(capped)).not.toBe(renderCost(whole));
  });

  // The same shape the sweep outage gets: one line on the transition, not one per sample for the life of
  // the app. Nothing throws when an admission is refused, so this log is the only main-process trace.
  it('names the retention ceiling once on reaching it, not once per sample', async () => {
    h.setLogs(REPO, spread(BANKED_CEILING + 1));
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    for (let i = 0; i < 4; i += 1) {
      h.setLogs(REPO, spread(BANKED_CEILING + 1 + i));
      await h.sample();
    }
    expect(h.logged).toHaveLength(1);
  });

  it('stops admitting new models past its ceiling, leaving the run`s unpriced list bounded', async () => {
    const models = (count: number): PricedTurn[] =>
      Array.from({ length: count }, (_, i) => turn({ at: FLOOR + 1 + i, id: `m${i}`, model: `made-up-${i}`, input: 1000 }));
    h.setLogs(REPO, models(MAX_BANKED_MODELS + 50));
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)!.cost.unpricedModels).toHaveLength(MAX_BANKED_MODELS);
    expect(h.meter.current(REPO)!.capped).toBe(true);
  });

  it('keeps counting a turn under a model it has already seen once the model ceiling is reached', async () => {
    const seed = Array.from({ length: MAX_BANKED_MODELS }, (_, i) =>
      turn({ at: FLOOR + 1 + i, id: `m${i}`, model: i === 0 ? 'claude-sonnet-5' : `made-up-${i}`, input: 0, output: 0 }),
    );
    h.setLogs(REPO, seed);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)!.cost.usd).toBe(0);

    h.setLogs(REPO, [...seed, turn({ at: FLOOR + 9_000, id: 'late', input: MTOK })]);
    await h.sample();
    expect(h.meter.current(REPO)!.cost.usd).toBe(3);
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
    const logs: PricedTurn[] = [turn({ at: FLOOR + 1, id: 'work', input: MTOK })];
    let armed: (() => Promise<void>) | null = null;
    const meter = createAppCostMeter({
      sampleDelayMs: BASE_DELAY,
      maxBankedTurns: BANKED_CEILING,
      openSweep: () => ({
        drain: () => ({
          async *[Symbol.asyncIterator]() {
            for (const t of logs) yield t;
          },
        }),
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
    expect(meter.current(REPO)?.cost.usd).toBe(3);
  });

  it('never throws out of the push itself, even when opening the sweep fails', () => {
    expect(() => h.meter.pushWindow(REPO, LOOP, Number.NaN)).not.toThrow();
    expect(() => h.meter.pushWindow(REPO, null, null)).not.toThrow();

    const meter = createAppCostMeter({
      sampleDelayMs: BASE_DELAY,
      maxBankedTurns: BANKED_CEILING,
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
    expect(() => meter.pushWindow(REPO, LOOP, FLOOR)).not.toThrow();
    expect(meter.current(REPO)).toBeNull();
  });
});
