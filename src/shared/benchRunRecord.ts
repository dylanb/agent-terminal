// #180 — the run record (docs/bench.md): the runner writes one per run, and every later reader (Bench-1b,
// Bench-1c, Bench-2) reads it through this module.

import { BENCH_APP_ENDINGS } from './benchLaunch';
import type { BenchSpan } from './benchLaunch';

/** Inside a run folder. */
export const BENCH_RUN_RECORD_FILE = 'run-record.json';
/** Inside a run folder: the copy of that run's §25 audit log. */
export const BENCH_RUN_AUDIT_DIR = 'audit';

export const BENCH_RUN_RECORD_SCHEMA = 1;

export const BENCH_RUN_ENDINGS = [...BENCH_APP_ENDINGS, 'app exited'] as const;
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

export function parseBenchRunRecord(text: string): BenchRunRecordRead {
  return { ok: true, record: JSON.parse(text) as BenchRunRecord };
}
