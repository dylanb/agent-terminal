import { describe, expect, it } from 'vitest';
import { sameOccurrence, type Occurrence } from '../../src/shared/occurrence';

// §24.2.3 T4 — occurrence identity is the SINGLE definition both the OS notification dedup (main
// loopNotifier) and the in-app attention cue (renderer) compare against; if it drifts, the two
// disagree on what counts as the same human-needed entry.

const occ = (over: Partial<Occurrence> = {}): Occurrence => ({
  repoKey: '/repo',
  status: 'awaiting-human-pr-approval',
  iteration: 9,
  ...over,
});

describe('sameOccurrence (shared identity, §24.2.3 T4)', () => {
  it('is true when repoKey, status, and iteration all match', () => {
    expect(sameOccurrence(occ(), occ())).toBe(true);
  });

  it('is false when the repoKey differs (a distinct loop per §16.3)', () => {
    expect(sameOccurrence(occ({ repoKey: '/a' }), occ({ repoKey: '/b' }))).toBe(false);
  });

  it('is false when the status differs within the same iteration', () => {
    expect(sameOccurrence(occ({ status: 'awaiting-human-pr-approval' }), occ({ status: 'impasse' }))).toBe(false);
  });

  it('is false when the iteration advances', () => {
    expect(sameOccurrence(occ({ iteration: 9 }), occ({ iteration: 10 }))).toBe(false);
  });

  it('treats a null occurrence on either side as not matching', () => {
    expect(sameOccurrence(null, occ())).toBe(false);
    expect(sameOccurrence(occ(), null)).toBe(false);
    expect(sameOccurrence(null, null)).toBe(false);
  });

  it('matches a null repoKey to a null repoKey (the cue keys by a possibly-null repo)', () => {
    expect(sameOccurrence(occ({ repoKey: null }), occ({ repoKey: null }))).toBe(true);
    expect(sameOccurrence(occ({ repoKey: null }), occ({ repoKey: '/repo' }))).toBe(false);
  });
});
