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

  // Claude Code logs a `<synthetic>` model for API-error turns with every token field at zero. It bills
  // nothing, so it is not a pricing gap: naming it in unpricedModels would append `+unknown` to a readout
  // that is in fact complete.
  it('a zero-token model is not an unpriced gap, whatever its id', () => {
    const r = priceTokens([{ model: '<synthetic>', input: 0, cacheCreate: 0, cacheRead: 0, output: 0 }]);
    expect(r).toEqual({ usd: 0, unpricedModels: [] });
  });

  it('a zero-token unpriced model alongside a priced one leaves the readout complete', () => {
    const p = PRICING[priced];
    const r = priceTokens([
      { model: priced, input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 0 },
      { model: '<synthetic>', input: 0, cacheCreate: 0, cacheRead: 0, output: 0 },
    ]);
    expect(r.usd).toBeCloseTo(p.input, 6);
    expect(r.unpricedModels).toEqual([]);
    expect(formatCost(r)).not.toContain('unknown');
  });

  it('an unpriced model with real tokens is still a gap', () => {
    const r = priceTokens([{ model: 'x-unknown', input: 1, cacheCreate: 0, cacheRead: 0, output: 0 }]);
    expect(r.unpricedModels).toEqual(['x-unknown']);
  });

  // The model id is a raw string out of Claude Code's private log format, so it can name a member of
  // Object.prototype. A lookup that resolves through the prototype chain returns a truthy non-price, skips
  // the unpriced branch, and multiplies tokens by `undefined` — a NaN total that no equality can ever call
  // unchanged, so every later sample re-reports and re-records it (CWE-1321).
  it('treats a model id naming an Object.prototype member as unpriced, never pricing it to NaN', () => {
    for (const hostile of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const r = priceTokens([{ model: hostile, input: 1_000_000, cacheCreate: 0, cacheRead: 0, output: 0 }]);
      expect(r.usd, hostile).toBe(0);
      expect(Number.isNaN(r.usd), hostile).toBe(false);
      expect(r.unpricedModels, hostile).toEqual([hostile]);
    }
  });

  // The models the loop actually runs on must be in the table, or every real readout reads `+unknown`.
  it('prices the models the hosted agent and its reviewer subagents run on', () => {
    for (const model of ['claude-opus-4-8', 'claude-sonnet-4-6']) {
      expect(PRICING[model], `${model} missing from PRICING`).toBeDefined();
    }
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
