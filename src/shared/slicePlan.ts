// §28.4.1 — the impl-slice grammar: the plan-bundle's slice-plan enumerates the RED/GREEN impl-slices of ONE
// ticket, and the plan-bundle approve gate sources their COUNT into the `slices` flow input the refactor step's
// loop-back reads (§28.4.1). An impl-slice is a RED/GREEN unit inside one ticket's slice-plan (§28.2 P2a)
// — DISTINCT from an epic-slice (a sub-ticket, §28.7). CLAUDE.md composed-prompt-is-a-writer: one writer (the
// plan-bundle recipe) and readers (the gate-time derivation, the tests) share this one definition, so a token
// change moves them together; the predicate grades the MINIMAL contract, never a rigid layout.

/** The grammar tokens `parseSlicePlan`, `slicePlanWellFormed`, and `exampleSlicePlan` all read from, so the
 *  parser and the writer cannot desync on a token's spelling. `## Impl-slices` is disjoint from §28.7's
 *  `## Sub-tickets`, so an epic plan's sub-tickets are never miscounted as impl-slices. */
export const SLICE_GRAMMAR = {
  implSlicesHeading: '## Impl-slices',
  implSlice: '### Impl-slice',
  ac: 'Acceptance criteria:',
} as const;

/** One impl-slice, in authored order. `body` is the block's text VERBATIM (heading to the next / EOF). */
export interface ImplSlice {
  index: number;
  title: string;
  body: string;
}

/** The `<index> — <title>` suffix after the grammar's impl-slice token. */
const IMPL_SLICE_SUFFIX = /^\s+(\d+)\b(.*)$/;

function headingTitle(rest: string): string {
  return rest.replace(/^\s*[—:-]\s*/, '').trim();
}

/** An impl-slice heading parsed from the grammar's `implSlice` token (so the reader shares the writer's token),
 *  or null when the line is not one. Matched only within the `## Impl-slices` block so a `### Impl-slice` line
 *  quoted elsewhere in the plan prose is never counted. */
function parseImplSliceHeading(line: string): { index: number; title: string } | null {
  const t = line.trim();
  if (!t.startsWith(SLICE_GRAMMAR.implSlice)) return null;
  const m = IMPL_SLICE_SUFFIX.exec(t.slice(SLICE_GRAMMAR.implSlice.length));
  if (m === null) return null;
  return { index: Number(m[1]), title: headingTitle(m[2]) };
}

/** Parse the `## Impl-slices` block into its ordered impl-slice blocks (each from its heading to the next
 *  heading, the next `##` section, or EOF). Empty `implSlices` when no block is present. Lenient — kept in
 *  authored order, neither deduplicated nor reordered; `slicePlanWellFormed` is what gates. */
export function parseSlicePlan(planText: string): { implSlices: ImplSlice[] } {
  const implSlices: ImplSlice[] = [];
  let inBlock = false;
  let current: { index: number; title: string; body: string[] } | null = null;
  const flush = (): void => {
    if (current === null) return;
    implSlices.push({ index: current.index, title: current.title, body: current.body.join('\n').trim() });
    current = null;
  };
  for (const line of planText.split('\n')) {
    const t = line.trim();
    if (t === SLICE_GRAMMAR.implSlicesHeading) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    // A new `## ` section (that is not another entry heading) ends the block.
    if (t.startsWith('## ')) {
      flush();
      inBlock = false;
      continue;
    }
    const heading = parseImplSliceHeading(line);
    if (heading !== null) {
      flush();
      current = { index: heading.index, title: heading.title, body: [] };
      continue;
    }
    if (current !== null) current.body.push(line);
  }
  flush();
  return { implSlices };
}

/** Whether the slice-plan meets the MINIMAL contract: a `## Impl-slices` block with ≥1 entry, each with a
 *  non-empty title AND an `Acceptance criteria:` line, and DISTINCT indices (a repeat would ambiguate the count
 *  and collapse two slices). Tolerates surrounding prose. */
export function slicePlanWellFormed(planText: string): boolean {
  const { implSlices } = parseSlicePlan(planText);
  if (implSlices.length === 0) return false;
  const indices = new Set(implSlices.map((s) => s.index));
  if (indices.size !== implSlices.length) return false;
  return implSlices.every(
    (s) => s.title.length > 0 && s.body.split('\n').some((l) => l.trim().startsWith(SLICE_GRAMMAR.ac)),
  );
}

/** The impl-slice count the plan-bundle sources into the `slices` input (§28.4.1). A well-formed slice-plan
 *  yields its entry count; an absent or malformed block yields 1 — a single-slice run exactly as before, so a
 *  plan that never authored the block (or authored it wrongly) never drives a half-working multi-slice chain
 *  (the flow additionally clamps to [1, MAX_SLICES], CWE-770). The integration slice runs once AFTER the loop
 *  as its own flow step and is deliberately NOT part of this count. */
export function implSliceCount(planText: string): number {
  return slicePlanWellFormed(planText) ? parseSlicePlan(planText).implSlices.length : 1;
}

/** The one canonical example the predicate test, the fake-agent output, and the recipe few-shot all reference,
 *  so they cannot drift (§93). Asserted `slicePlanWellFormed` by its test. */
export function exampleSlicePlan(n = 2): string {
  const lines = [SLICE_GRAMMAR.implSlicesHeading, ''];
  for (let i = 1; i <= n; i++) {
    lines.push(
      `${SLICE_GRAMMAR.implSlice} ${i} — Slice ${i} of the feature`,
      `${SLICE_GRAMMAR.ac} acceptance criterion ${i} is observably satisfied`,
      '',
      `Plan for impl-slice ${i}: the thin RED/GREEN vertical that delivers criterion ${i} end to end.`,
      '',
    );
  }
  return lines.join('\n');
}
