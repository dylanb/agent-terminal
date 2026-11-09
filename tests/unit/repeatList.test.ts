import { describe, expect, it } from 'vitest';
import { countToSource, repeatListTitles } from '../../src/shared/repeatList';
import { exampleSlicePlan } from '../../src/shared/slicePlan';
import { JSON_LIST_CASES, jsonListText } from '../helpers/jsonListCases';

const IMPL_SLICES = { format: 'impl-slices' } as const;
const STEPS = { format: 'json-list', list: 'steps' } as const;

describe('repeatListTitles — the entries a list gives, in file order', () => {
  it("gives an impl-slices block's heading titles in file order, whatever their numbers", () => {
    expect(repeatListTitles(IMPL_SLICES, exampleSlicePlan(3))).toEqual(['Slice 1 of the feature', 'Slice 2 of the feature', 'Slice 3 of the feature']);
    const reordered = '## Impl-slices\n\n### Impl-slice 2 — Second first\nAcceptance criteria: a\n\n### Impl-slice 1 — First second\nAcceptance criteria: b\n';
    expect(repeatListTitles(IMPL_SLICES, reordered)).toEqual(['Second first', 'First second']);
  });

  it('sources nothing from a malformed or absent impl-slices block, or an epic plan, beside a well-formed one', () => {
    expect.soft(repeatListTitles(IMPL_SLICES, exampleSlicePlan(2))).toEqual(['Slice 1 of the feature', 'Slice 2 of the feature']);
    expect.soft(repeatListTitles(IMPL_SLICES, '## Impl-slices\n')).toBeNull();
    expect.soft(repeatListTitles(IMPL_SLICES, '## Impl-slices\n\n### Impl-slice 1 — no ac line\n')).toBeNull();
    expect.soft(repeatListTitles(IMPL_SLICES, '# plan\n\n## Slice plan\n\nprose only, no structured block\n')).toBeNull();
    const epic = 'Classification: epic\n\n## Sub-tickets\n\n### Sub-ticket 1 — a\nAcceptance criteria: x\n\n### Sub-ticket 2 — b\nAcceptance criteria: y\n';
    expect.soft(repeatListTitles(IMPL_SLICES, epic)).toBeNull();
  });

  it("gives a well-formed json-list file's titles from the named key", () => {
    expect(repeatListTitles(STEPS, jsonListText(['Parse', 'Render']))).toEqual(['Parse', 'Render']);
    expect(repeatListTitles({ format: 'json-list', list: 'items' }, jsonListText(['Only'], 'items'))).toEqual(['Only']);
  });

  it.each(JSON_LIST_CASES.filter((c) => !c.expected.wellFormed).map((c) => [c.name, c] as const))('sources nothing from a json-list file with %s, beside a well-formed file under the same key', (_name, c) => {
    const spec = { format: 'json-list', list: c.list } as const;
    expect.soft(repeatListTitles(spec, jsonListText(['Kept'], c.list))).toEqual(['Kept']);
    expect.soft(repeatListTitles(spec, c.text)).toBeNull();
  });
});

describe('countToSource — the count a list sources, or none so the standing count stays (§28.4.1)', () => {
  it('sources the entry count when the list covers the iteration the run is on', () => {
    expect(countToSource(3, 1)).toBe(3);
    expect(countToSource(8, 4)).toBe(8);
    expect(countToSource(4, 4)).toBe(4);
  });

  it('sources nothing when the list has fewer entries than the iteration the run is on, beside one that covers it', () => {
    expect.soft(countToSource(3, 3)).toBe(3);
    expect.soft(countToSource(3, 4)).toBeNull();
    expect.soft(countToSource(1, 2)).toBeNull();
  });
});
