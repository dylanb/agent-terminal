import { describe, expect, it } from 'vitest';
import { PRICING, priceTokens, formatCost, addTokens, sortedTotals, type ModelTokens } from '../../src/shared/pricing';

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

  // `CostResult` documents `usd` as always finite so the readout never renders `$NaN` and never blocks,
  // but the counts come from Claude Code's private log format and reach the multiply unchecked on §26's
  // path. `1e308 * 15` overflows BEFORE the divide, and one overflow to +Infinity beside one to -Infinity
  // is NaN — a figure that then reaches the strip, the §25 record and the persisted state.yaml, where it
  // reads back as `.nan`. The postcondition is the type's own, so it is enforced where the type is built
  // (CWE-20, CWE-1339, OWASP ASVS V5.1.4).
  it('holds usd finite whatever counts it is handed, so the readout never renders NaN or Infinity', () => {
    const hostile: ModelTokens[][] = [
      [{ model: priced, input: -1e308, cacheCreate: 1e308, cacheRead: 0, output: 1 }],
      [{ model: priced, input: 0, cacheCreate: 0, cacheRead: 0, output: 1e308 }],
      [{ model: priced, input: Number.POSITIVE_INFINITY, cacheCreate: 0, cacheRead: 0, output: 0 }],
      [{ model: priced, input: Number.NaN, cacheCreate: 0, cacheRead: 0, output: 0 }],
    ];
    for (const totals of hostile) {
      const r = priceTokens(totals);
      expect(Number.isFinite(r.usd), JSON.stringify(totals)).toBe(true);
      expect(formatCost(r), JSON.stringify(totals)).not.toMatch(/NaN|Infinity/);
    }
  });

  it('leaves an ordinary in-range total exactly as it prices it', () => {
    const p = PRICING[priced];
    expect(priceTokens([{ model: priced, input: 2_000_000, cacheCreate: 0, cacheRead: 0, output: 0 }]).usd).toBeCloseTo(
      p.input * 2,
      6,
    );
  });

  // The models the loop actually runs on must be in the table, or every real readout reads `+unknown`.
  it('prices the models the hosted agent and its reviewer subagents run on', () => {
    for (const model of ['claude-opus-4-8', 'claude-sonnet-4-6']) {
      expect(PRICING[model], `${model} missing from PRICING`).toBeDefined();
    }
  });
});

// The fold from per-turn tokens to per-model totals runs on both engines' paths — §26's whole-file
// aggregate and §27's live per-turn banking. It belongs to the module that owns what a token total IS, so
// a newly billed token category is a compile error at one site rather than a silent under-count at another.
describe('folding per-turn tokens into per-model totals', () => {
  const zero = (model: string): ModelTokens => ({ model, input: 0, cacheCreate: 0, cacheRead: 0, output: 0 });

  it('sums every field of two turns of the same model', () => {
    const into = new Map<string, ModelTokens>();
    addTokens(into, { model: 'm', input: 1, cacheCreate: 2, cacheRead: 3, output: 4 });
    addTokens(into, { model: 'm', input: 10, cacheCreate: 20, cacheRead: 30, output: 40 });
    expect(sortedTotals(into)).toEqual([{ model: 'm', input: 11, cacheCreate: 22, cacheRead: 33, output: 44 }]);
  });

  it('keeps distinct models apart and orders the result by model id', () => {
    const into = new Map<string, ModelTokens>();
    for (const model of ['zeta', 'alpha', 'zeta']) addTokens(into, { ...zero(model), input: 1 });
    expect(sortedTotals(into)).toEqual([
      { ...zero('alpha'), input: 1 },
      { ...zero('zeta'), input: 2 },
    ]);
  });

  it('folds an empty map to no totals', () => {
    expect(sortedTotals(new Map())).toEqual([]);
  });

  // The model id is a raw string out of Claude Code's private log format, so it can name an
  // Object.prototype member — the same input the priced lookup is hardened against.
  it('folds a model id naming an Object.prototype member like any other', () => {
    const into = new Map<string, ModelTokens>();
    addTokens(into, { ...zero('__proto__'), input: 5 });
    addTokens(into, { ...zero('__proto__'), output: 2 });
    expect(sortedTotals(into)).toEqual([{ ...zero('__proto__'), input: 5, output: 2 }]);
  });

  it('leaves the turn it folded untouched, so a caller may keep reading it', () => {
    const turn = { ...zero('m'), input: 3 };
    addTokens(new Map(), turn);
    expect(turn).toEqual({ ...zero('m'), input: 3 });
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
