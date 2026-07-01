// Model→dollar pricing for the §26.10 cost meter. Shared (CLAUDE.md src/shared rule) so the main-process
// meter that prices tokens for the §25 audit and the renderer strip that formats the readout agree on both
// the price table and the display string, and cannot drift. Prices are per MILLION tokens (the published
// unit). The table is a checked-in default kept current by hand; an id absent from it is UNPRICED (§26.10).

/** Per-model token totals summed from the session JSONL (§26.10) — one entry per distinct `message.model`. */
export interface ModelTokens {
  model: string;
  input: number;
  cacheCreate: number;
  cacheRead: number;
  output: number;
}

/** A priced result (§26.10): `usd` is the summed dollars of every PRICED model; `unpricedModels` names each
 *  model absent from the table (each contributes zero, surfaced as `unknown`). `usd` is always finite —
 *  never NaN — so the readout never renders `$NaN` and never blocks. */
export interface CostResult {
  usd: number;
  unpricedModels: string[];
}

/** Per-million-token USD prices for one model. `cacheCreate`/`cacheRead` are the prompt-cache write/read rates. */
interface ModelPrice {
  input: number;
  cacheCreate: number;
  cacheRead: number;
  output: number;
}

/** The checked-in default pricing table (§26.10) — current Claude model ids at their per-Mtoken USD prices,
 *  refreshed by hand. An id absent here (a new, aliased, `[1m]`-suffixed, or non-Claude id) is UNPRICED:
 *  it contributes zero dollars and surfaces as `unknown` (a display gap, never an error). */
export const PRICING: Record<string, ModelPrice> = {
  'claude-opus-4-8': { input: 15, cacheCreate: 18.75, cacheRead: 1.5, output: 75 },
  'claude-opus-4-7': { input: 15, cacheCreate: 18.75, cacheRead: 1.5, output: 75 },
  'claude-sonnet-5': { input: 3, cacheCreate: 3.75, cacheRead: 0.3, output: 15 },
  'claude-fable-5': { input: 3, cacheCreate: 3.75, cacheRead: 0.3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, cacheCreate: 1.25, cacheRead: 0.1, output: 5 },
};

/** Price per-model token totals against PRICING (§26.10). A model absent from the table contributes zero
 *  dollars and is named once in `unpricedModels`; the returned `usd` is always finite. */
export function priceTokens(totals: ModelTokens[]): CostResult {
  let usd = 0;
  const unpricedModels: string[] = [];
  for (const t of totals) {
    const price = PRICING[t.model];
    if (!price) {
      if (!unpricedModels.includes(t.model)) unpricedModels.push(t.model);
      continue;
    }
    usd +=
      (t.input * price.input + t.cacheCreate * price.cacheCreate + t.cacheRead * price.cacheRead + t.output * price.output) /
      1_000_000;
  }
  return { usd, unpricedModels };
}

/** The status-strip / audit-viewer readout for a cost (§26.10). Never `$NaN`: an all-unpriced result reads
 *  `unknown`, a partially-priced one appends ` +unknown`, a fully-priced one is `$X.XX`. */
export function formatCost(result: CostResult): string {
  const priced = `$${result.usd.toFixed(2)}`;
  if (result.unpricedModels.length === 0) return priced;
  return result.usd === 0 ? 'unknown' : `${priced} +unknown`;
}
