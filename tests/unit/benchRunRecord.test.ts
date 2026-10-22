import { describe, expect, it } from 'vitest';
import { BENCH_RUN_RECORD_SCHEMA, EXAMPLE_BENCH_RUN_RECORD, parseBenchRunRecord } from '../../src/shared/benchRunRecord';

// #180 — the run record's versioning rule (docs/bench.md): a field added without breaking a reader keeps the
// version and a reader ignores it; only a breaking change bumps the version, and a reader refuses one it does not
// know.

describe('reading a run record', () => {
  it('ignores a key it does not know and returns the known fields unchanged', () => {
    const text = JSON.stringify({ ...EXAMPLE_BENCH_RUN_RECORD, tokens: { input: 1200 } });

    expect(parseBenchRunRecord(text)).toEqual({ ok: true, record: EXAMPLE_BENCH_RUN_RECORD });
  });

  it.each([
    ['a schema_version it does not know', { ...EXAMPLE_BENCH_RUN_RECORD, schema_version: BENCH_RUN_RECORD_SCHEMA + 1 }],
    ['an ending no run can have', { ...EXAMPLE_BENCH_RUN_RECORD, ending: 'crashed' }],
    ['no prompt revision', { ...EXAMPLE_BENCH_RUN_RECORD, promptRevision: undefined }],
    ['a wall-clock time that is not a number', { ...EXAMPLE_BENCH_RUN_RECORD, wallClockMs: '42' }],
    ['an issue copy number that is not an integer', { ...EXAMPLE_BENCH_RUN_RECORD, issueCopy: { number: 1.5 } }],
    ['a flow with no id', { ...EXAMPLE_BENCH_RUN_RECORD, flow: { definitionRevision: EXAMPLE_BENCH_RUN_RECORD.flow.definitionRevision } }],
    ['no fixture', { ...EXAMPLE_BENCH_RUN_RECORD, fixture: undefined }],
    ['a span with no last step', { ...EXAMPLE_BENCH_RUN_RECORD, span: { first: 'plan' } }],
    ['a fixture issue numbered 0', { ...EXAMPLE_BENCH_RUN_RECORD, fixtureIssue: { ...EXAMPLE_BENCH_RUN_RECORD.fixtureIssue, number: 0 } }],
    ['a blank branch', { ...EXAMPLE_BENCH_RUN_RECORD, branch: ' ' }],
    ['a negative wall-clock time', { ...EXAMPLE_BENCH_RUN_RECORD, wallClockMs: -1 }],
  ])('refuses the canonical record with %s', (_, record) => {
    expect(parseBenchRunRecord(JSON.stringify(record)).ok).toBe(false);
  });

  it.each([
    ['text that is not JSON', '{ "schema_version": 1, '],
    ['a JSON array', JSON.stringify([EXAMPLE_BENCH_RUN_RECORD])],
  ])('refuses %s', (_, text) => {
    expect(parseBenchRunRecord(text).ok).toBe(false);
  });

  it('reads a wall-clock time of 0', () => {
    const record = { ...EXAMPLE_BENCH_RUN_RECORD, wallClockMs: 0 };

    expect(parseBenchRunRecord(JSON.stringify(record))).toEqual({ ok: true, record });
  });
});
