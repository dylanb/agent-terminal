// docs/bench.md

import { BENCH_APP_ENDINGS } from './benchLaunch';
import type { BenchSpan } from './benchLaunch';

/** Inside a run folder. */
export const BENCH_RUN_RECORD_FILE = 'run-record.json';
/** Inside a run folder: the copy of that run's §25 audit log. */
export const BENCH_RUN_AUDIT_DIR = 'audit';

export const BENCH_RUN_RECORD_SCHEMA = 1;

export const BENCH_RUN_ENDINGS = [...BENCH_APP_ENDINGS, 'app exited', 'app did not start'] as const;
export type BenchRunEnding = (typeof BENCH_RUN_ENDINGS)[number];

export interface BenchRunRecord {
  schema_version: number;
  flow: { id: string; definitionRevision: string };
  promptRevision: string;
  fixture: string;
  span: BenchSpan;
  fixtureIssue: { repository: string; number: number };
  issueCopy: { number: number };
  branch: string;
  ending: BenchRunEnding;
  wallClockMs: number;
}

/** The canonical run record docs/bench.md embeds. */
export const EXAMPLE_BENCH_RUN_RECORD: BenchRunRecord = {
  schema_version: BENCH_RUN_RECORD_SCHEMA,
  flow: { id: 'feature-dev-v3', definitionRevision: '3f1c0b7e9a2d4c6f8e0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e' },
  promptRevision: '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d',
  fixture: '/home/operator/fixtures/gate-probe',
  span: { first: 'plan', last: 'plan' },
  fixtureIssue: { repository: 'github.com/owner/repo', number: 137 },
  issueCopy: { number: 412 },
  branch: 'bench/20261020T120000.000Z/run-1',
  ending: 'left span',
  wallClockMs: 754000,
};

export type BenchRunRecordRead = { ok: true; record: BenchRunRecord } | { ok: false; reason: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonBlank = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isPositiveInteger = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isDuration = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** CWE-20 — refuses a `schema_version` it does not know and any known field it cannot read; ignores, and drops,
 *  every key it does not know (docs/bench.md's versioning rule). */
export function parseBenchRunRecord(text: string): BenchRunRecordRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (!isPlainObject(raw)) return { ok: false, reason: 'not a run record object' };
  if (raw.schema_version !== BENCH_RUN_RECORD_SCHEMA) return { ok: false, reason: 'unknown schema_version' };
  const { flow, span, fixtureIssue, issueCopy } = raw;
  if (!isPlainObject(flow) || !isNonBlank(flow.id) || !isNonBlank(flow.definitionRevision)) return { ok: false, reason: 'flow is not an id and a definition revision' };
  if (!isNonBlank(raw.promptRevision)) return { ok: false, reason: 'promptRevision is missing' };
  if (!isNonBlank(raw.fixture)) return { ok: false, reason: 'fixture is missing' };
  if (!isPlainObject(span) || !isNonBlank(span.first) || !isNonBlank(span.last)) return { ok: false, reason: 'span is not a first and last step' };
  if (!isPlainObject(fixtureIssue) || !isNonBlank(fixtureIssue.repository) || !isPositiveInteger(fixtureIssue.number)) {
    return { ok: false, reason: 'fixtureIssue is not a repository and a positive number' };
  }
  if (!isPlainObject(issueCopy) || !isPositiveInteger(issueCopy.number)) return { ok: false, reason: 'issueCopy is not a positive number' };
  if (!isNonBlank(raw.branch)) return { ok: false, reason: 'branch is missing' };
  const ending = BENCH_RUN_ENDINGS.find((e) => e === raw.ending);
  if (ending === undefined) return { ok: false, reason: 'not an ending a run can have' };
  if (!isDuration(raw.wallClockMs)) return { ok: false, reason: 'wallClockMs is not a whole number of milliseconds' };
  return {
    ok: true,
    record: {
      schema_version: BENCH_RUN_RECORD_SCHEMA,
      flow: { id: flow.id, definitionRevision: flow.definitionRevision },
      promptRevision: raw.promptRevision,
      fixture: raw.fixture,
      span: { first: span.first, last: span.last },
      fixtureIssue: { repository: fixtureIssue.repository, number: fixtureIssue.number },
      issueCopy: { number: issueCopy.number },
      branch: raw.branch,
      ending,
      wallClockMs: raw.wallClockMs,
    },
  };
}

export function serializeBenchRunRecord(record: BenchRunRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
