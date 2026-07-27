import { beforeEach, describe, expect, it } from 'vitest';
import { createAppCostMeter, type AppCostMeter } from '../../src/main/appCostMeter';
import type { SessionTurn } from '../../src/main/sessionLogSweep';
import type { CostResult } from '../../src/shared/pricing';

const REPO = '/repo/one';
const OTHER = '/repo/two';
const FLOOR = 1_000_000;
const LOOP = 'plan-loop';

const turn = (opts: {
  at: number;
  id?: string | null;
  model?: string;
  input?: number;
  output?: number;
}): SessionTurn => ({
  at: opts.at,
  id: opts.id === undefined ? `id-${opts.at}` : opts.id,
  model: opts.model ?? 'claude-sonnet-5',
  input: opts.input ?? 0,
  cacheCreate: 0,
  cacheRead: 0,
  output: opts.output ?? 0,
});

/** 1,000,000 claude-sonnet-5 input tokens is exactly $3.00 against the checked-in table. */
const MTOK = 1_000_000;

interface Harness {
  meter: AppCostMeter;
  /** Fire the armed sample for a repo and wait for it to drain. */
  sample(repoDir?: string): Promise<void>;
  /** Take the armed sample without running it, so a test can interleave a push with it. */
  takeArmed(repoDir?: string): (() => Promise<void>) | undefined;
  /** Whether a sample is armed for a repo. */
  armed(repoDir?: string): boolean;
  sweeps: { repoDir: string; since: number | null }[];
  figureChanges: number;
  recorded: { repoDir: string; cost: CostResult }[];
  setLogs(repoDir: string, turns: SessionTurn[]): void;
  failSweep(): void;
  now: number;
}

function harness(): Harness {
  const logs = new Map<string, SessionTurn[]>();
  const armedRuns = new Map<string, () => Promise<void>>();
  let sweepThrows = false;
  const h: Harness = {
    meter: undefined as unknown as AppCostMeter,
    sweeps: [],
    figureChanges: 0,
    recorded: [],
    now: FLOOR + 10_000,
    setLogs: (repoDir, turns) => void logs.set(repoDir, turns),
    failSweep: () => {
      sweepThrows = true;
    },
    armed: (repoDir = REPO) => armedRuns.has(repoDir),
    takeArmed: (repoDir = REPO) => {
      const run = armedRuns.get(repoDir);
      armedRuns.delete(repoDir);
      return run;
    },
    sample: async (repoDir = REPO) => {
      await h.takeArmed(repoDir)?.();
    },
  };
  h.meter = createAppCostMeter({
    turns: (repoDir, since) => {
      h.sweeps.push({ repoDir, since });
      // The seam promises every turn the logs hold AT OR AFTER `since`, and excludes any turn with no usable
      // instant — so the fake honours both, or an assertion on the meter's total grades the fake instead.
      const scripted = (logs.get(repoDir) ?? []).filter(
        (t) => Number.isFinite(t.at) && (since === null || t.at >= since),
      );
      return {
        async *[Symbol.asyncIterator]() {
          if (sweepThrows) throw new Error('log root unreadable');
          for (const t of scripted) yield t;
        },
      };
    },
    now: () => h.now,
    armSample: (repoDir, run) => void armedRuns.set(repoDir, run),
    cancelSample: (repoDir) => void armedRuns.delete(repoDir),
    onFigureChanged: () => {
      h.figureChanges += 1;
    },
    recordCost: (repoDir, cost) => void h.recorded.push({ repoDir, cost }),
    log: () => {},
  });
  return h;
}

let h: Harness;
beforeEach(() => {
  h = harness();
});

describe('the §27 run total', () => {
  // AC 1 — the readout covers the WHOLE run: the work turn, every reviewer subagent, the consolidator, the
  // polish conversation and every retry. The stream is what walks the nested logs; the meter accumulates
  // every turn it is handed into one running figure.
  it('accumulates every priced turn in the window into one running total', async () => {
    h.setLogs(REPO, [
      turn({ at: FLOOR + 1, id: 'work', input: MTOK }),
      turn({ at: FLOOR + 2, id: 'reviewer', output: MTOK / 10 }),
      turn({ at: FLOOR + 3, id: 'consolidator', input: MTOK }),
    ]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)).toEqual({ usd: 3 + 1.5 + 3, unpricedModels: [] });
  });

  it('rises when a later sample discovers a further turn, and signals the view changed once per move', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(3);
    expect(h.figureChanges).toBe(1);

    h.setLogs(REPO, [
      turn({ at: FLOOR + 1, id: 'work', input: MTOK }),
      turn({ at: FLOOR + 5, id: 'retry', input: MTOK }),
    ]);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(6);
    expect(h.figureChanges).toBe(2);

    await h.sample(); // nothing new — the figure did not move
    expect(h.figureChanges).toBe(2);
  });

  // AC 2 — the sweep is bounded below by the flow's recorded start.
  it('sweeps from the recorded start, so turns logged before it are excluded', async () => {
    h.setLogs(REPO, [
      turn({ at: FLOOR - 1, id: 'before', input: 100 * MTOK }),
      turn({ at: FLOOR, id: 'at-floor', input: MTOK }),
    ]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.sweeps[0]).toEqual({ repoDir: REPO, since: FLOOR });
    expect(h.meter.current(REPO)?.usd).toBe(3);
  });

  // AC 2 — a flow with no recorded start sweeps UNBOUNDED. An unbounded number is wrong; a silent zero
  // hides that it is wrong, so the meter must still report the sweep rather than declining to run.
  it('sweeps unbounded when the flow records no start, and never substitutes $0', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR - 500_000, id: 'ancient', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, null);
    await h.sample();
    expect(h.sweeps[0]).toEqual({ repoDir: REPO, since: null });
    expect(h.meter.current(REPO)).toEqual({ usd: 3, unpricedModels: [] });
  });

  // A floor after the present survives every field-local check while doing maximum damage: the pre-filter
  // then excludes every log and the strip reads $0.00 for a run that spent money. Clamping to no-floor
  // lands on the unbounded sweep — a wrong-but-loud number rather than a silent zero.
  it('clamps a floor dated in the future to no recorded floor rather than filtering every log away', async () => {
    h.setLogs(REPO, [turn({ at: h.now - 1000, id: 'real', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, h.now + 3_600_000);
    await h.sample();
    expect(h.sweeps[0].since).toBeNull();
    expect(h.meter.current(REPO)?.usd).toBe(3);
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
    expect(h.meter.current(REPO)?.usd).toBe(3);

    h.setLogs(REPO, [
      turn({ at: FLOOR + 9, id: 'work', input: MTOK }),
      turn({ at: FLOOR + 1, id: 'work', input: MTOK }),
    ]);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(3);
  });

  it('counts every unidentifiable turn, since collapsing them would hide real spend', async () => {
    h.setLogs(REPO, [
      turn({ at: FLOOR + 1, id: null, input: MTOK }),
      turn({ at: FLOOR + 2, id: null, input: MTOK }),
    ]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(6);
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
    const cost = h.meter.current(REPO);
    expect(cost).toEqual({ usd: 3, unpricedModels: ['claude-made-up-9'] });
    expect(Number.isFinite(cost?.usd)).toBe(true);
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
    expect(h.sweeps).toEqual([]);
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
    expect(h.meter.current(REPO)?.usd).toBe(3);

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
    expect(h.meter.current(OTHER)?.usd).toBe(3);
  });

  // A chain advance leaves the recorded floor untouched, so the run — and its total — continues.
  it('keeps the accumulated figure across a loop-name change on the same floor', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    h.meter.pushWindow(REPO, 'plan-loop', FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(3);

    h.meter.pushWindow(REPO, 'impl-loop', FLOOR);
    expect(h.meter.current(REPO)?.usd).toBe(3);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(3);
  });

  // A restart stamps a NEW floor: that is a new run, and its figure starts from zero rather than carrying
  // the previous run's banked turns forward.
  it('starts a fresh figure when the recorded floor moves', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(3);

    h.meter.pushWindow(REPO, LOOP, FLOOR + 100);
    expect(h.meter.current(REPO)).toBeNull();
    h.setLogs(REPO, [turn({ at: FLOOR + 101, id: 'fresh', output: MTOK / 10 })]);
    await h.sample();
    expect(h.meter.current(REPO)?.usd).toBe(1.5);
  });

  // AC 8a — the flow hydrates on EVERY render and therefore reaches the push, so the seeding read has to be
  // deferred rather than run on it. Neither the push nor the readout may sweep.
  it('sweeps nothing on the push or on the readout — only on the deferred sample', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    for (let i = 0; i < 20; i += 1) {
      h.meter.pushWindow(REPO, LOOP, FLOOR);
      h.meter.current(REPO);
    }
    expect(h.sweeps).toEqual([]);
    await h.sample();
    expect(h.sweeps).toHaveLength(1);
    for (let i = 0; i < 20; i += 1) h.meter.current(REPO);
    expect(h.sweeps).toHaveLength(1);
  });

  it('re-pushing an unchanged triple neither re-arms a sample nor disturbs the figure', async () => {
    h.setLogs(REPO, [turn({ at: FLOOR + 1, id: 'work', input: MTOK })]);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await h.sample();
    expect(h.armed()).toBe(true); // the sample re-arms itself while the run is open
    await h.sample();
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    expect(h.meter.current(REPO)?.usd).toBe(3);
    expect(h.sweeps).toHaveLength(2);
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
  });

  // AC 7 — the meter is display-only. A run whose cost cannot be computed AT ALL completes exactly as one
  // that priced cleanly: nothing here may throw into the flow path.
  it('swallows a sweep that fails outright, keeps sampling, and never throws', async () => {
    h.failSweep();
    h.meter.pushWindow(REPO, LOOP, FLOOR);
    await expect(h.sample()).resolves.toBeUndefined();
    expect(h.meter.current(REPO)).toBeNull();
    expect(h.recorded).toEqual([]);
    expect(h.armed()).toBe(true);
  });

  it('swallows a throwing audit recorder and a throwing view-changed signal', async () => {
    const logs: SessionTurn[] = [turn({ at: FLOOR + 1, id: 'work', input: MTOK })];
    let armed: (() => Promise<void>) | null = null;
    const meter = createAppCostMeter({
      turns: () => ({
        async *[Symbol.asyncIterator]() {
          for (const t of logs) yield t;
        },
      }),
      now: () => FLOOR + 10_000,
      armSample: (_repoDir, run) => {
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

  it('never throws out of the push itself', () => {
    expect(() => h.meter.pushWindow(REPO, LOOP, Number.NaN)).not.toThrow();
    expect(() => h.meter.pushWindow(REPO, null, null)).not.toThrow();
  });
});
