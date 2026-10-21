import { describe, expect, it } from 'vitest';
import {
  SLICE_GRAMMAR,
  parseSlicePlan,
  slicePlanWellFormed,
  exampleSlicePlan,
  sliceCountToSource,
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

describe('exampleSlicePlan anchors the predicate (§93 canonical example)', () => {
  it('is well-formed and parses to N impl-slices for any N', () => {
    for (const n of [1, 2, 3, 5]) {
      const plan = exampleSlicePlan(n);
      expect(slicePlanWellFormed(plan)).toBe(true);
      expect(parseSlicePlan(plan).implSlices.length).toBe(n);
      expect(sliceCountToSource(plan, 1)).toBe(n);
    }
  });
});

// §28.4.1 — every approve gate that declares the `plan` output re-sources the count, the RED gate included once
// RED may split its own slice (§28.5.3), so a later plan that cannot carry the run must leave the count standing.
describe('sliceCountToSource — the count an approve gate writes, or none to keep the current one (§28.4.1)', () => {
  it('sources the plan\'s count when the plan is well-formed and covers the slice the run is on', () => {
    expect(sliceCountToSource(exampleSlicePlan(3), 1)).toBe(3);
    expect(sliceCountToSource(exampleSlicePlan(8), 4)).toBe(8);
    expect(sliceCountToSource(exampleSlicePlan(4), 4)).toBe(4);
  });

  it('sources nothing for a malformed or absent block, so the count already sourced (or the flow\'s single-slice default) stands', () => {
    expect(sliceCountToSource('## Impl-slices\n', 1)).toBeNull();
    expect(sliceCountToSource('## Impl-slices\n\n### Impl-slice 1 — no ac line\n', 1)).toBeNull();
    expect(sliceCountToSource('# plan\n\n## Slice plan\n\nprose only, no structured block\n', 3)).toBeNull();
  });

  it('does not count an epic plan\'s sub-tickets as impl-slices (distinct concepts, §28.2 P2a)', () => {
    const epic = 'Classification: epic\n\n## Sub-tickets\n\n### Sub-ticket 1 — a\nAcceptance criteria: x\n\n### Sub-ticket 2 — b\nAcceptance criteria: y\n';
    expect(sliceCountToSource(epic, 1)).toBeNull();
  });

  it('sources nothing when the plan has fewer slices than the one the run is on', () => {
    expect(sliceCountToSource(exampleSlicePlan(3), 4)).toBeNull();
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
