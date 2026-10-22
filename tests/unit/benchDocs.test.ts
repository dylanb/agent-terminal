import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXAMPLE_BENCH_FIXTURE, parseBenchFixture } from '../../src/shared/benchFixture';
import { EXAMPLE_BENCH_RUN_RECORD, parseBenchRunRecord } from '../../src/shared/benchRunRecord';

// #180 AC 13 — the formats docs/bench.md documents are the ones the shared readers read: each fenced JSON example
// the doc carries parses with its module's reader and equals that module's canonical example.

const DOC = join(process.cwd(), 'docs', 'bench.md');

/** The body of every ```json fence in the doc; none when the doc is absent. */
function jsonFences(): string[] {
  const text = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
  return [...text.matchAll(/^```json\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
}

describe('docs/bench.md (#180 AC 13)', () => {
  it('carries the canonical fixture example, which the fixture reader reads', () => {
    const fixtures = jsonFences().flatMap((t) => {
      const read = parseBenchFixture(t);
      return read.ok ? [read.fixture] : [];
    });
    expect(fixtures).toEqual([EXAMPLE_BENCH_FIXTURE]);
  });

  it('carries the canonical run-record example, which the record reader reads', () => {
    const records = jsonFences().flatMap((t) => {
      const read = parseBenchRunRecord(t);
      return read.ok ? [read.record] : [];
    });
    expect(records).toEqual([EXAMPLE_BENCH_RUN_RECORD]);
  });
});
