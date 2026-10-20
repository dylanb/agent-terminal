// #180 — the bench fixture manifest (docs/bench.md): `bench capture` writes it, `bench run` reads it, and an
// operator may write it by hand.

export const BENCH_FIXTURE_MANIFEST = 'fixture.json';
/** Beside the manifest, mirroring the working folder's loop artifacts directory. */
export const BENCH_FIXTURE_ARTIFACTS = 'artifacts';

export interface BenchFixture {
  schema_version: number;
  commit: string;
  phase_baseline?: string;
  issue: { repository: string; number: number };
  inputs: Record<string, string>;
  repeat_counts: Record<string, number>;
}

export type BenchFixtureRead = { ok: true; fixture: BenchFixture } | { ok: false; reason: string };

export function parseBenchFixture(_text: string): BenchFixtureRead {
  return { ok: false, reason: 'unimplemented' };
}
