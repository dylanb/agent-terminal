// #180 — the runner-to-app launch contract: the env value the runner launches the app with, the endings the app
// observes, and the span-end file the app writes and the runner reads.

import type { StepSpan } from './flowStepSpan';

/** The env var the runner sets on the app it launches, holding the encoded launch value. */
export const BENCH_LAUNCH_ENV = 'AGENT_TERMINAL_BENCH_LAUNCH';

export const BENCH_LAUNCH_SCHEMA = 1;
export const BENCH_SPAN_END_SCHEMA = 1;

export type BenchSpan = StepSpan;

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

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasExactKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(v, k));
const isNonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isAbsolutePath = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/');

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function encodeBenchLaunch(launch: BenchLaunch): string {
  return JSON.stringify(launch);
}

/** CWE-20 — fails closed on any key or value the contract does not define. */
export function decodeBenchLaunch(text: string): BenchLaunchRead {
  const raw = parseJson(text);
  if (!isPlainObject(raw) || !hasExactKeys(raw, ['schema_version', 'workingFolder', 'span', 'spanEndFile'])) return { ok: false, reason: 'not a launch value' };
  if (raw.schema_version !== BENCH_LAUNCH_SCHEMA) return { ok: false, reason: 'unknown schema_version' };
  if (!isAbsolutePath(raw.workingFolder) || !isAbsolutePath(raw.spanEndFile)) return { ok: false, reason: 'a path is not absolute' };
  const span = raw.span;
  if (!isPlainObject(span) || !hasExactKeys(span, ['first', 'last']) || !isNonBlank(span.first) || !isNonBlank(span.last)) {
    return { ok: false, reason: 'span is not a first and last step' };
  }
  return { ok: true, launch: { schema_version: BENCH_LAUNCH_SCHEMA, workingFolder: raw.workingFolder, span: { first: span.first, last: span.last }, spanEndFile: raw.spanEndFile } };
}

export function serializeBenchSpanEnd(ending: BenchAppEnding): string {
  return `${JSON.stringify({ schema_version: BENCH_SPAN_END_SCHEMA, ending })}\n`;
}

export function parseBenchSpanEnd(text: string): BenchSpanEndRead {
  const raw = parseJson(text);
  if (!isPlainObject(raw) || !hasExactKeys(raw, ['schema_version', 'ending'])) return { ok: false, reason: 'not a span-end file' };
  if (raw.schema_version !== BENCH_SPAN_END_SCHEMA) return { ok: false, reason: 'unknown schema_version' };
  const ending = BENCH_APP_ENDINGS.find((e) => e === raw.ending);
  return ending === undefined ? { ok: false, reason: 'not an ending the app writes' } : { ok: true, ending };
}
