import { describe, expect, it } from 'vitest';
import { railTotal, runTokens, type StepTokens, type TokenKinds } from '../../src/shared/tokenCounts';

const kinds = (cacheRead: number, cacheWrite: number, input: number, output: number): TokenKinds => ({
  cacheRead: { reported: 'all', n: cacheRead },
  cacheWrite: { reported: 'all', n: cacheWrite },
  input: { reported: 'all', n: input },
  output: { reported: 'all', n: output },
});
const billed = (k: TokenKinds): StepTokens => ({ state: 'counted', billed: true, kinds: k });
const unbilled: StepTokens = { state: 'counted', billed: false, kinds: kinds(0, 0, 0, 0) };

describe('runTokens', () => {
  it('is null while no step is entered', () => {
    expect(runTokens([])).toBeNull();
  });

  it('sums each kind over the entered steps', () => {
    expect(runTokens([billed(kinds(1_000, 200, 30, 4)), billed(kinds(50_000, 6_000, 700, 80))])).toEqual({
      state: 'counted',
      someStepsUnavailable: false,
      kinds: kinds(51_000, 6_200, 730, 84),
    });
  });

  it('adds nothing for an entered step that billed no call', () => {
    expect(runTokens([unbilled, billed(kinds(9_000, 800, 70, 6)), unbilled])).toEqual({
      state: 'counted',
      someStepsUnavailable: false,
      kinds: kinds(9_000, 800, 70, 6),
    });
  });

  it('reads 0 in every kind when no entered step billed', () => {
    expect(runTokens([unbilled, unbilled])).toEqual({ state: 'counted', someStepsUnavailable: false, kinds: kinds(0, 0, 0, 0) });
  });
});

describe('runTokens — partly and not reported', () => {
  const NONE = { reported: 'none' } as const;
  const some = (n: number) => ({ reported: 'some', n }) as const;

  it('reads a kind partly reported, with the reported sum, when only some billed steps reported it', () => {
    expect(runTokens([billed(kinds(20_000, 1_200, 300, 430)), billed({ ...kinds(9_000, 0, 140, 260), cacheWrite: NONE })])).toEqual({
      state: 'counted',
      someStepsUnavailable: false,
      kinds: { ...kinds(29_000, 0, 440, 690), cacheWrite: some(1_200) },
    });
  });

  it('reads a kind not reported when no billed step reported it', () => {
    expect(runTokens([billed({ ...kinds(9_000, 0, 140, 260), cacheWrite: NONE }), billed({ ...kinds(3_000, 0, 25, 70), cacheWrite: NONE })])).toEqual({
      state: 'counted',
      someStepsUnavailable: false,
      kinds: { ...kinds(12_000, 0, 165, 330), cacheWrite: NONE },
    });
  });

  it('a step that billed nothing never makes a cell partly reported', () => {
    expect(runTokens([unbilled, billed({ ...kinds(9_000, 0, 140, 260), cacheWrite: NONE }), unbilled])).toMatchObject({ kinds: { cacheWrite: NONE } });
  });

  it('a single billed step whose cell is partly reported gives a partly reported run total', () => {
    expect(runTokens([unbilled, billed({ ...kinds(8_000, 0, 85, 150), cacheWrite: some(400) })])).toEqual({
      state: 'counted',
      someStepsUnavailable: false,
      kinds: { ...kinds(8_000, 0, 85, 150), cacheWrite: some(400) },
    });
  });

  it('a fully reported step and a partly reported one give a partly reported cell', () => {
    expect(runTokens([billed(kinds(20_000, 1_200, 300, 430)), billed({ ...kinds(8_000, 0, 85, 150), cacheWrite: some(400) })])).toMatchObject({ kinds: { cacheWrite: some(1_600) } });
  });
});

describe('railTotal', () => {
  it('is the sum of the 4 kinds, unmarked when every kind is reported', () => {
    expect(railTotal(kinds(12_000, 300, 45, 6))).toEqual({ n: 12_351, partly: false });
  });

  it('is 0 for a step with no spend', () => {
    expect(railTotal(kinds(0, 0, 0, 0))).toEqual({ n: 0, partly: false });
  });

  it('sums the reported figures and is marked partly reported when a kind is not reported', () => {
    expect(railTotal({ ...kinds(9_000, 0, 140, 260), cacheWrite: { reported: 'none' } })).toEqual({ n: 9_400, partly: true });
  });

  it('is marked partly reported when a kind is partly reported', () => {
    expect(railTotal({ ...kinds(8_000, 0, 85, 150), cacheWrite: { reported: 'some', n: 400 } })).toEqual({ n: 8_635, partly: true });
  });
});

describe('runTokens — unavailable steps', () => {
  const UNAVAILABLE: StepTokens = { state: 'unavailable' };
  const NONE = { reported: 'none' } as const;

  it('sums only the counted steps, marked incomplete, when some entered steps are unavailable', () => {
    expect(runTokens([billed(kinds(12_000, 340, 56, 78)), UNAVAILABLE, unbilled])).toEqual({
      state: 'counted',
      someStepsUnavailable: true,
      kinds: kinds(12_000, 340, 56, 78),
    });
  });

  it('is unavailable, not 0 marked incomplete, when every entered step is unavailable', () => {
    expect([runTokens([UNAVAILABLE]), runTokens([UNAVAILABLE, UNAVAILABLE])]).toEqual([{ state: 'unavailable' }, { state: 'unavailable' }]);
  });

  it('keeps a partly reported cell partly reported when the total is also incomplete', () => {
    expect(runTokens([billed(kinds(20_000, 1_200, 300, 430)), billed({ ...kinds(9_000, 0, 140, 260), cacheWrite: NONE }), UNAVAILABLE])).toEqual({
      state: 'counted',
      someStepsUnavailable: true,
      kinds: { ...kinds(29_000, 0, 440, 690), cacheWrite: { reported: 'some', n: 1_200 } },
    });
  });

  it('reads a kind not reported, incomplete, when the only countable step reported none of it', () => {
    expect(runTokens([UNAVAILABLE, billed({ ...kinds(9_000, 0, 140, 260), cacheWrite: NONE })])).toEqual({
      state: 'counted',
      someStepsUnavailable: true,
      kinds: { ...kinds(9_000, 0, 140, 260), cacheWrite: NONE },
    });
  });
});
