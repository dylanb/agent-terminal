import { describe, expect, it } from 'vitest';
import { prunablePersonas, recordCleanPersonas, type PersonaStateEntry } from '../../src/main/personaSkip';

// §26.5/§26.13 L6 — the fan-out skip-optimization. A persona that reviewed CLEAN on the immediately
// prior iteration AND whose per-phase footprint is unchanged is pruned from the next fan-out and its
// last-clean review reused. Plan phase footprint = the plan.md digest; impl phase = the reviewed file set.
describe('persona skip-opt pruning (§26.5 / §26.13 L6)', () => {
  const roster = ['review-principal', 'review-security', 'review-architecture'];

  it('prunes a persona clean at iteration-1 with an unchanged plan digest (plan phase)', () => {
    const state: Record<string, PersonaStateEntry> = {
      'review-principal': { lastCleanIter: 1, lastSeenPlanDigest: 'D', lastSeenFiles: [] },
      'review-security': { lastCleanIter: 1, lastSeenPlanDigest: 'D', lastSeenFiles: [] },
    };
    const { active, pruned } = prunablePersonas(roster, state, 2, { kind: 'plan', digest: 'D' });
    expect(pruned).toEqual(['review-principal', 'review-security']);
    expect(active).toEqual(['review-architecture']); // never clean-recorded → still reviewed
  });

  it('does NOT prune when the plan digest changed since the last clean review', () => {
    const state: Record<string, PersonaStateEntry> = {
      'review-principal': { lastCleanIter: 1, lastSeenPlanDigest: 'OLD', lastSeenFiles: [] },
    };
    const { active, pruned } = prunablePersonas(roster, state, 2, { kind: 'plan', digest: 'NEW' });
    expect(pruned).toEqual([]);
    expect(active).toEqual(roster);
  });

  it('does NOT prune a persona whose last-clean iteration is not exactly iteration-1', () => {
    const state: Record<string, PersonaStateEntry> = {
      'review-principal': { lastCleanIter: 1, lastSeenPlanDigest: 'D', lastSeenFiles: [] }, // clean 2 iters ago
    };
    const { pruned } = prunablePersonas(roster, state, 3, { kind: 'plan', digest: 'D' });
    expect(pruned).toEqual([]);
  });

  it('prunes on an unchanged reviewed-file set (impl phase), order-insensitively', () => {
    const state: Record<string, PersonaStateEntry> = {
      'review-principal': { lastCleanIter: 1, lastSeenPlanDigest: '', lastSeenFiles: ['a.ts', 'b.ts'] },
    };
    const { pruned } = prunablePersonas(roster, state, 2, { kind: 'impl', files: ['b.ts', 'a.ts'] });
    expect(pruned).toEqual(['review-principal']);
  });

  it('does NOT prune when the reviewed-file set changed (impl phase)', () => {
    const state: Record<string, PersonaStateEntry> = {
      'review-principal': { lastCleanIter: 1, lastSeenPlanDigest: '', lastSeenFiles: ['a.ts'] },
    };
    const { pruned } = prunablePersonas(roster, state, 2, { kind: 'impl', files: ['a.ts', 'c.ts'] });
    expect(pruned).toEqual([]);
  });

  it('records this iteration clean personas with the current plan footprint, preserving other entries', () => {
    const prior: Record<string, PersonaStateEntry> = {
      'review-architecture': { lastCleanIter: 1, lastSeenPlanDigest: 'OLD', lastSeenFiles: [] },
    };
    const next = recordCleanPersonas(prior, ['review-principal', 'review-security'], 2, { kind: 'plan', digest: 'D' });
    expect(next['review-principal']).toEqual({ lastCleanIter: 2, lastSeenPlanDigest: 'D', lastSeenFiles: [] });
    expect(next['review-security']).toEqual({ lastCleanIter: 2, lastSeenPlanDigest: 'D', lastSeenFiles: [] });
    expect(next['review-architecture']).toEqual({ lastCleanIter: 1, lastSeenPlanDigest: 'OLD', lastSeenFiles: [] }); // untouched
  });
});
