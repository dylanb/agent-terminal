import { describe, expect, it, vi } from 'vitest';
import { createGithubRefs, ghArgs, parseGithubRef } from '../../src/main/githubRefs';

// §24.2.3 T7 — the best-effort GitHub ref resolver shells out to `gh` and NEVER throws: any failure
// (no gh, not a repo, offline, malformed) degrades to null so the popout shows the bare number.

describe('ghArgs — the gh sub-command per ref kind, naming the repository', () => {
  it('builds an issue view request for a ticket', () => {
    expect(ghArgs('issue', 25, 'github.com/o/r')).toEqual(['issue', 'view', '25', '--repo', 'github.com/o/r', '--json', 'title,body,url']);
  });
  it('builds a pr view request for a PR', () => {
    expect(ghArgs('pr', 29, 'github.com/o/r')).toEqual(['pr', 'view', '29', '--repo', 'github.com/o/r', '--json', 'title,body,url']);
  });
});

describe('parseGithubRef — degrading parse of gh JSON', () => {
  it('parses a well-formed ref document', () => {
    const raw = JSON.stringify({ title: 'Fix the thing', body: 'Steps to repro', url: 'https://github.com/o/r/issues/25' });
    expect(parseGithubRef(raw)).toEqual({ title: 'Fix the thing', body: 'Steps to repro', url: 'https://github.com/o/r/issues/25' });
  });
  it('returns null for null input (gh produced nothing)', () => {
    expect(parseGithubRef(null)).toBeNull();
  });
  it('returns null for non-JSON', () => {
    expect(parseGithubRef('gh: command not found')).toBeNull();
  });
  it('returns null when a required field is missing or mistyped', () => {
    expect(parseGithubRef(JSON.stringify({ title: 'x', url: 'https://github.com/o/r/issues/1' }))).toBeNull();
    expect(parseGithubRef(JSON.stringify({ title: 1, body: 'b', url: 'u' }))).toBeNull();
  });
});

describe('createGithubRefs — caching + degradation', () => {
  const REF = { title: 't', body: 'b', url: 'https://github.com/o/r/issues/25' };

  it('resolves a fetched ref and caches a success (one fetch per identity)', async () => {
    const fetchRaw = vi.fn(async () => JSON.stringify(REF));
    const refs = createGithubRefs({ fetchRaw });
    expect(await refs('/repo', 'issue', 25)).toEqual(REF);
    expect(await refs('/repo', 'issue', 25)).toEqual(REF);
    expect(fetchRaw).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by (repo, kind, number) — distinct refs fetch independently', async () => {
    const fetchRaw = vi.fn(async () => JSON.stringify(REF));
    const refs = createGithubRefs({ fetchRaw });
    await refs('/repo', 'issue', 25);
    await refs('/repo', 'pr', 25);
    expect(fetchRaw).toHaveBeenCalledTimes(2);
  });

  it('returns null and does NOT cache a failure, so a later call retries', async () => {
    const fetchRaw = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(JSON.stringify(REF));
    const refs = createGithubRefs({ fetchRaw });
    expect(await refs('/repo', 'issue', 25)).toBeNull();
    expect(await refs('/repo', 'issue', 25)).toEqual(REF);
    expect(fetchRaw).toHaveBeenCalledTimes(2);
  });

  it('never throws — a rejecting fetch degrades to null', async () => {
    const fetchRaw = vi.fn().mockRejectedValue(new Error('boom'));
    const refs = createGithubRefs({ fetchRaw });
    expect(await refs('/repo', 'issue', 25)).toBeNull();
  });
});
