import { describe, expect, it } from 'vitest';
import {
  SLICE_GRAMMAR,
  parseSlicePlan,
  slicePlanWellFormed,
  exampleSlicePlan,
} from '../../src/shared/slicePlan';

// §28.4.1 — the impl-slice count the plan-bundle sources into the `slices` flow input. An impl-slice is a
// RED/GREEN unit inside ONE ticket's slice-plan (§28.2 P2a) — DISTINCT from an epic-slice
// (a sub-ticket). One writer (the plan-bundle recipe) and readers (the gate-time derivation, the tests) share
// this grammar; the predicate grades the MINIMAL contract, never a rigid layout (CLAUDE.md serialized-contract).

describe('the impl-slice grammar tokens are fixed (§28.4.1)', () => {
  it('names the block and entry headings', () => {
    expect(SLICE_GRAMMAR.implSlicesHeading).toBe('## Impl-slices');
    expect(SLICE_GRAMMAR.implSlice).toBe('### Impl-slice');
  });
});

describe('parseSlicePlan — ordered impl-slice extraction', () => {
  it('returns entries in authored order with index + title', () => {
    const parsed = parseSlicePlan(exampleSlicePlan(2));
    expect(parsed.implSlices.map((s) => s.index)).toEqual([1, 2]);
    expect(parsed.implSlices.map((s) => s.title)).toEqual(['Slice 1 of the feature', 'Slice 2 of the feature']);
  });
});

describe('slicePlanWellFormed — the minimal contract, never a rigid layout', () => {
  it('rejects an empty block, and requires an AC line per entry with distinct indices', () => {
    expect(slicePlanWellFormed('## Impl-slices\n')).toBe(false);
    expect(slicePlanWellFormed('## Impl-slices\n\n### Impl-slice 1 — a\n')).toBe(false); // no AC
    const dupe = '## Impl-slices\n\n### Impl-slice 1 — a\nAcceptance criteria: x\n\n### Impl-slice 1 — b\nAcceptance criteria: y\n';
    expect(slicePlanWellFormed(dupe)).toBe(false); // duplicate index collapses two slices
  });
});
