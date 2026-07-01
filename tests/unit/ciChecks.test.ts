import { describe, expect, it } from 'vitest';
import { parseCiChecks } from '../../src/main/ciChecks';

// §26.7 — CI is run-don't-block. At review time the app takes a best-effort `gh pr checks` snapshot of
// whatever CI state already exists (never waiting on pending checks) and records it display-only. The
// snapshot is Claude/gh's `bucket` categorization; the parser degrades to null (omit) on drift or no checks.
describe('CI checks snapshot parse (§26.7)', () => {
  const line = (bucket: string): Record<string, string> => ({ bucket });

  it('counts pass / fail / pending buckets over all checks', () => {
    const raw = JSON.stringify([line('pass'), line('pass'), line('fail'), line('pending')]);
    expect(parseCiChecks(raw)).toEqual({ total: 4, passed: 2, failed: 1, pending: 1 });
  });

  it('counts other buckets (skipping/cancel) in the total only', () => {
    const raw = JSON.stringify([line('pass'), line('skipping'), line('cancel')]);
    expect(parseCiChecks(raw)).toEqual({ total: 3, passed: 1, failed: 0, pending: 0 });
  });

  it('no checks (empty array) is omitted — null, not a zero snapshot (§26.7 "omitted if none")', () => {
    expect(parseCiChecks('[]')).toBeNull();
  });

  it('unparseable output degrades to null (never throws)', () => {
    expect(parseCiChecks('not json {{{')).toBeNull();
    expect(parseCiChecks('')).toBeNull();
    expect(parseCiChecks('{"not":"an array"}')).toBeNull();
  });

  it('a check missing its bucket is counted in the total but no category', () => {
    const raw = JSON.stringify([line('pass'), { name: 'no-bucket' }]);
    expect(parseCiChecks(raw)).toEqual({ total: 2, passed: 1, failed: 0, pending: 0 });
  });
});
