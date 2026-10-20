// #180 — the runner-to-app launch contract: the env value the runner launches the app with, the endings the app
// observes, and the span-end file the app writes and the runner reads.

/** The env var the runner sets on the app it launches, holding the encoded launch value. */
export const BENCH_LAUNCH_ENV = 'AGENT_TERMINAL_BENCH_LAUNCH';

export const BENCH_LAUNCH_SCHEMA = 1;

export interface BenchSpan {
  first: string;
  last: string;
}

export interface BenchLaunch {
  schema_version: number;
  workingFolder: string;
  span: BenchSpan;
  spanEndFile: string;
}

export const BENCH_APP_ENDINGS = ['left span', 'completed', 'terminated', 'window closed'] as const;
export type BenchAppEnding = (typeof BENCH_APP_ENDINGS)[number];

export type BenchLaunchRead = { ok: true; launch: BenchLaunch } | { ok: false; reason: string };
export type BenchSpanEndRead = { ok: true; ending: BenchAppEnding } | { ok: false; reason: string };

export function encodeBenchLaunch(launch: BenchLaunch): string {
  return JSON.stringify(launch);
}

export function decodeBenchLaunch(_text: string): BenchLaunchRead {
  return { ok: true, launch: { schema_version: 0, workingFolder: '', span: { first: '', last: '' }, spanEndFile: '' } };
}

export function serializeBenchSpanEnd(ending: BenchAppEnding): string {
  return ending;
}

export function parseBenchSpanEnd(_text: string): BenchSpanEndRead {
  return { ok: true, ending: 'left span' };
}
