// A fake AppLauncher and BenchClock for the bench runner's tests (#180). The launcher logs `open k` the moment
// `open()` is called and `exit k` only when the promise it returned settles, on a later macrotask, so a runner
// that does not wait for one app to exit shows `open 1, open 2` before any exit.

import { writeFileSync } from 'node:fs';
import type { AppLauncher } from '../../src/main/benchLauncher';
import type { BenchClock } from '../../src/main/benchRun';
import { serializeBenchSpanEnd, type BenchAppEnding, type BenchLaunch } from '../../src/shared/benchLaunch';

export interface FakeBenchClock extends BenchClock {
  advance(ms: number): void;
}

/** `now()` moves only when a fake advances it. `stamps` are handed out in order; past them, `stamp-<n>`. */
export function createFakeBenchClock(stamps: string[] = []): FakeBenchClock {
  let t = 1_000_000;
  let n = 0;
  return {
    now: () => t,
    stamp: () => stamps[n++] ?? `stamp-${n}`,
    advance: (ms) => {
      t += ms;
    },
  };
}

export interface FakeLaunchScript {
  /** The span-end file the "app" leaves, or `unparsable` for one no reader parses; none when absent. */
  ending?: BenchAppEnding | 'unparsable';
  /** How far the "app" moves the clock between `open k` and `exit k`. */
  durationMs?: number;
  /** How long, in real time, the "app" stays open before it exits; 5 ms when absent. */
  holdMs?: number;
}

export interface FakeLauncherOptions {
  /** One entry per launch the test expects; a launch past the list rejects and is logged `overrun k`. */
  scripts?: FakeLaunchScript[];
  events?: string[];
  clock?: FakeBenchClock;
  /** Runs at `open k`, while the "app" is open, with the launch value it was given. */
  inspect?: (launch: BenchLaunch, k: number) => void;
}

export interface FakeLauncher extends AppLauncher {
  launches: BenchLaunch[];
}

export function createFakeLauncher(opts: FakeLauncherOptions = {}): FakeLauncher {
  const scripts = opts.scripts ?? [{}];
  const events = opts.events ?? [];
  const launches: BenchLaunch[] = [];
  return {
    launches,
    open(launch) {
      launches.push(launch);
      const k = launches.length;
      const script = scripts[k - 1];
      if (script === undefined) {
        events.push(`overrun ${k}`);
        return Promise.reject(new Error(`fake launcher: launch ${k} has no script`));
      }
      events.push(`open ${k}`);
      opts.inspect?.(launch, k);
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          opts.clock?.advance(script.durationMs ?? 0);
          if (script.ending !== undefined) {
            writeFileSync(launch.spanEndFile, script.ending === 'unparsable' ? '{ not a span end' : serializeBenchSpanEnd(script.ending));
          }
          events.push(`exit ${k}`);
          resolve();
        }, script.holdMs ?? 5);
      });
    },
  };
}
