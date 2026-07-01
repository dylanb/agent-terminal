import { describe, expect, it } from 'vitest';
import { PRICING, priceTokens, formatCost, type ModelTokens } from '../../src/shared/pricing';

// §26.10 — the cost meter prices per-model token totals against a checked-in table and formats the readout.
// An id absent from the table contributes ZERO dollars and is surfaced as `unknown` — the meter never NaN.
describe('token pricing (§26.10)', () => {
  const priced = Object.keys(PRICING)[0]; // any table id, so the test does not pin exact prices

  it('prices a known model from the table (input/cache/output summed, per-million)', () => {
    const p = PRICING[priced];
    const totals: ModelTokens[] = [{ model: priced, input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 0 }];
    const r = priceTokens(totals);
    expect(r.usd).toBeCloseTo(p.input, 6); // 1M input tokens = one input-price unit
    expect(r.unpricedModels).toEqual([]);
  });

  it('sums every priced model into one dollar total', () => {
    const p = PRICING[priced];
    const totals: ModelTokens[] = [
      { model: priced, input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 0 },
      { model: priced, input: 0, cacheCreate: 0, cacheRead: 0, output: 1_000_000 },
    ];
    expect(priceTokens(totals).usd).toBeCloseTo(p.input + p.output, 6);
  });

  it('an unpriced model contributes zero dollars and is named in unpricedModels (never NaN)', () => {
    const r = priceTokens([{ model: 'claude-made-up-9', input: 5_000_000, cacheCreate: 0, cacheRead: 0, output: 5_000_000 }]);
    expect(r.usd).toBe(0);
    expect(Number.isNaN(r.usd)).toBe(false);
    expect(r.unpricedModels).toEqual(['claude-made-up-9']);
  });

  it('mixes priced + unpriced: the priced sum stands, the unpriced id is listed once', () => {
    const p = PRICING[priced];
    const r = priceTokens([
      { model: priced, input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 0 },
      { model: 'x-unknown', input: 9_000_000, cacheCreate: 0, cacheRead: 0, output: 0 },
      { model: 'x-unknown', input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 0 },
    ]);
    expect(r.usd).toBeCloseTo(p.input, 6);
    expect(r.unpricedModels).toEqual(['x-unknown']);
  });

  it('empty totals price to $0 with no unpriced models', () => {
    expect(priceTokens([])).toEqual({ usd: 0, unpricedModels: [] });
  });
});

describe('cost readout formatting (§26.10 — never NaN)', () => {
  it('a fully-priced result reads $X.XX', () => {
    expect(formatCost({ usd: 0.42, unpricedModels: [] })).toBe('$0.42');
    expect(formatCost({ usd: 0, unpricedModels: [] })).toBe('$0.00');
  });

  it('an all-unpriced result (no priced dollars) reads unknown, never $NaN', () => {
    expect(formatCost({ usd: 0, unpricedModels: ['x'] })).toBe('unknown');
  });

  it('a partially-priced result shows the priced dollars plus an unknown marker', () => {
    expect(formatCost({ usd: 1.5, unpricedModels: ['x'] })).toBe('$1.50 +unknown');
  });
});
