// #180 — the bench fixture manifest (docs/bench.md): `bench capture` writes it, `bench run` reads it, and an
// operator may write it by hand.

import { isGitObjectId } from './appBootstrap';
import { isRepeatCount, isStringValue } from './flowStateValues';
import { validGitHubRepositorySelector } from './githubSelector';

export const BENCH_FIXTURE_MANIFEST = 'fixture.json';
/** Beside the manifest, mirroring the working folder's loop artifacts directory. */
export const BENCH_FIXTURE_ARTIFACTS = 'artifacts';

export const BENCH_FIXTURE_SCHEMA = 1;

export interface BenchFixture {
  schema_version: number;
  commit: string;
  phase_baseline?: string;
  issue: { repository: string; number: number };
  inputs: Record<string, string>;
  repeat_counts: Record<string, number>;
}

export type BenchFixtureRead = { ok: true; fixture: BenchFixture } | { ok: false; reason: string };

export const isFixtureIssueNumber = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

const FIXTURE_KEYS = new Set(['schema_version', 'commit', 'phase_baseline', 'issue', 'inputs', 'repeat_counts']);
const ISSUE_KEYS = new Set(['repository', 'number']);

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, allowed: Set<string>): boolean => Object.keys(v).every((k) => allowed.has(k));

function readMap<T>(v: unknown, isValue: (x: unknown) => x is T): Record<string, T> | null {
  if (!isPlainObject(v) || !Object.values(v).every(isValue)) return null;
  return Object.fromEntries(Object.entries(v)) as Record<string, T>;
}

/** CWE-20 — fails closed on any key or value the format does not define. */
export function parseBenchFixture(text: string): BenchFixtureRead {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (!isPlainObject(raw) || !onlyKeys(raw, FIXTURE_KEYS)) return { ok: false, reason: 'not a fixture object' };
  if (raw.schema_version !== BENCH_FIXTURE_SCHEMA) return { ok: false, reason: 'unknown schema_version' };
  if (typeof raw.commit !== 'string' || !isGitObjectId(raw.commit)) return { ok: false, reason: 'commit is not a git object id' };
  if (raw.phase_baseline !== undefined && (typeof raw.phase_baseline !== 'string' || !isGitObjectId(raw.phase_baseline))) {
    return { ok: false, reason: 'phase_baseline is not a git object id' };
  }
  const issue = raw.issue;
  if (
    !isPlainObject(issue) ||
    !onlyKeys(issue, ISSUE_KEYS) ||
    typeof issue.repository !== 'string' ||
    !validGitHubRepositorySelector(issue.repository) ||
    !isFixtureIssueNumber(issue.number)
  ) {
    return { ok: false, reason: 'issue is not a repository selector and a positive number' };
  }
  const inputs = readMap(raw.inputs, isStringValue);
  if (inputs === null) return { ok: false, reason: 'inputs are not string values' };
  const repeatCounts = readMap(raw.repeat_counts, isRepeatCount);
  if (repeatCounts === null) return { ok: false, reason: 'repeat_counts are not positive integers' };
  return {
    ok: true,
    fixture: {
      schema_version: BENCH_FIXTURE_SCHEMA,
      commit: raw.commit,
      ...(raw.phase_baseline !== undefined ? { phase_baseline: raw.phase_baseline } : {}),
      issue: { repository: issue.repository.toLowerCase(), number: issue.number },
      inputs,
      repeat_counts: repeatCounts,
    },
  };
}

export function serializeBenchFixture(fixture: BenchFixture): string {
  const ordered: BenchFixture = {
    schema_version: fixture.schema_version,
    commit: fixture.commit,
    ...(fixture.phase_baseline !== undefined ? { phase_baseline: fixture.phase_baseline } : {}),
    issue: { repository: fixture.issue.repository, number: fixture.issue.number },
    inputs: fixture.inputs,
    repeat_counts: fixture.repeat_counts,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
