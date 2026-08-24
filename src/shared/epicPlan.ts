// §28.7 — the epic-plan classification grammar: a serialized vocabulary with one writer (the plan-bundle work
// recipe, which tells the agent what to write) and multiple readers (the gate-time classification derivation
// that surfaces the split, the promotion executor that creates the sub-tickets, the tests). One definition in
// the shared layer so the recipe, the well-formedness predicate, and the parser cannot drift — the §93
// writer↔reader / composed-prompt-is-a-writer pattern (mirrors consolidatorOutput.ts). It grades the MINIMAL
// contract (classified epic ⟹ ≥1 well-formed sub-ticket block), never a rigid layout; the app never parses the
// epic's own acceptance criteria (§27.10) — the agent partitions them and the block body is copied as authored.

/** The classification token a plan carries when the work agent judges it an epic (§28.7). Spelled once. */
export const EPIC_CLASSIFICATION = 'epic';

/** The grammar labels the parser, the well-formedness predicate, and the canonical example all derive from, so
 *  token spelling cannot drift across writer/reader/example (mirrors CONSOLIDATOR_GRAMMAR). Pins the token
 *  names, not a rigid layout — an over-constrained template would diverge the fake-agent from the real recipe. */
export const EPIC_GRAMMAR = {
  classification: 'Classification:',
  subTicketsHeading: '## Sub-tickets',
  subTicket: '### Sub-ticket',
  ac: 'Acceptance criteria:',
  dependsOn: 'Depends on:',
} as const;

/** One epic-slice, in authored order. `body` is the block's text VERBATIM (the AC line + the approved plan
 *  slice) — how the approved plan is preserved into each sub-ticket (§27.10 "the approved plan verbatim");
 *  the promotion executor prepends/appends the epic link and the resolved preceding-slice number at runtime. */
export interface EpicSubTicket {
  index: number;
  title: string;
  body: string;
}

/** The value of the first `Classification:` labelled line, or null when none. */
function classificationValue(text: string): string | null {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith(EPIC_GRAMMAR.classification)) continue;
    return t.slice(EPIC_GRAMMAR.classification.length).trim();
  }
  return null;
}

/** Whether the work agent classified this plan an epic (§28.7) — the token drives classification surfacing and
 *  promotion. Exact-string, never normalized (mirrors the closed-set membership checks). */
export function isEpicPlan(planText: string): boolean {
  return classificationValue(planText) === EPIC_CLASSIFICATION;
}

const SUB_TICKET_HEADING = /^###\s+Sub-ticket\s+(\d+)\b(.*)$/;

/** Strip a leading title separator (em-dash / hyphen / colon) so `### Sub-ticket 1 — Foo` yields `Foo`. */
function headingTitle(rest: string): string {
  return rest.replace(/^\s*[—:-]\s*/, '').trim();
}

/** Parse an epic plan into its ordered sub-ticket blocks, or null when the plan is not classified an epic.
 *  Each block runs from its `### Sub-ticket k` heading to the next heading (or EOF); the body is verbatim.
 *  Lenient on structure — the well-formedness predicate is what gates; the promotion executor parses a plan
 *  already judged well-formed at the gate + by the human. */
export function parseEpicPlan(planText: string): { subTickets: EpicSubTicket[] } | null {
  if (!isEpicPlan(planText)) return null;
  const subTickets: EpicSubTicket[] = [];
  let current: { index: number; title: string; body: string[] } | null = null;
  const flush = (): void => {
    if (current === null) return;
    subTickets.push({ index: current.index, title: current.title, body: current.body.join('\n').trim() });
  };
  for (const line of planText.split('\n')) {
    const m = SUB_TICKET_HEADING.exec(line);
    if (m !== null) {
      flush();
      current = { index: Number(m[1]), title: headingTitle(m[2]), body: [] };
      continue;
    }
    if (current !== null) current.body.push(line);
  }
  flush();
  return { subTickets };
}

/** Whether the epic plan meets the MINIMAL contract (§28.5.5): classified an epic, ≥1 sub-ticket block, and
 *  every block carries a non-empty title AND an `Acceptance criteria:` line in its body. Never a rigid layout —
 *  surrounding prose the agent wrote is tolerated. */
export function epicPlanWellFormed(planText: string): boolean {
  const parsed = parseEpicPlan(planText);
  if (parsed === null || parsed.subTickets.length === 0) return false;
  return parsed.subTickets.every(
    (t) => t.title.length > 0 && t.body.split('\n').some((l) => l.trim().startsWith(EPIC_GRAMMAR.ac)),
  );
}

/** The single canonical example the predicate happy-path test, the fake-agent output, and the recipe few-shot
 *  all reference — one artifact so the consumers cannot drift (§93). `n` sub-tickets, each with a distinct
 *  title, an AC line, and a plan slice (which the promotion carries verbatim into the sub-ticket). */
export function exampleEpicPlan(n = 2): string {
  const lines = [`${EPIC_GRAMMAR.classification} ${EPIC_CLASSIFICATION}`, '', EPIC_GRAMMAR.subTicketsHeading, ''];
  for (let i = 1; i <= n; i++) {
    lines.push(
      `${EPIC_GRAMMAR.subTicket} ${i} — Slice ${i} of the feature`,
      `${EPIC_GRAMMAR.ac} acceptance criterion ${i} is observably satisfied`,
      `${EPIC_GRAMMAR.dependsOn} ${i === 1 ? 'none' : `#${i - 1}`}`,
      '',
      `Plan for slice ${i}: the thin vertical that delivers criterion ${i} end to end.`,
      '',
    );
  }
  return `${lines.join('\n')}`;
}
