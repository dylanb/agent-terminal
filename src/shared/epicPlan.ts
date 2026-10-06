// §28.7 — the epic-plan classification grammar. §93 / CLAUDE.md composed-prompt-is-a-writer: writers (the
// plan-bundle recipe, and the plan-polish recipe that must keep its tokens and appends POLISH_REPORT_HEADING) and
// readers (the gate-time derivation, the promotion executor, the tests) share this one definition, so if a token
// here changes, writers and readers move together. Grades the MINIMAL contract, never a
// rigid layout; §27.10 — the app never parses the epic's own ACs (the agent partitions them; the body is verbatim).

export const EPIC_CLASSIFICATION = 'epic';

/** §28.8.1 — the section the plan-polish turn appends after every machine-read block. It ends a sub-ticket block,
 *  so operator-facing polish notes never reach a sub-ticket's issue body. */
export const POLISH_REPORT_HEADING = '## Polish report';

/** The grammar tokens `parseEpicPlan`, `epicPlanWellFormed`, and `exampleEpicPlan` all read from, so the parser
 *  and the writer cannot desync on a token's spelling. */
export const EPIC_GRAMMAR = {
  classification: 'Classification:',
  subTicketsHeading: '## Sub-tickets',
  subTicket: '### Sub-ticket',
  ac: 'Acceptance criteria:',
  dependsOn: 'Depends on:',
} as const;

/** One epic-slice, in authored order. `body` is the block's text VERBATIM — the coupling the whole feature
 *  rests on: it carries the approved plan slice into the sub-ticket unchanged (§27.10 / the operator's
 *  plan-preservation requirement), so the promotion executor must not re-flow it. */
export interface EpicSubTicket {
  index: number;
  title: string;
  body: string;
}

function classificationValue(text: string): string | null {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith(EPIC_GRAMMAR.classification)) continue;
    return t.slice(EPIC_GRAMMAR.classification.length).trim();
  }
  return null;
}

/** Whether the work agent classified this plan an epic (§28.7). Exact-string, never normalized. */
export function isEpicPlan(planText: string): boolean {
  return classificationValue(planText) === EPIC_CLASSIFICATION;
}

/** The `<index> — <title>` suffix after the grammar's sub-ticket token. */
const SUB_TICKET_SUFFIX = /^\s+(\d+)\b(.*)$/;

function headingTitle(rest: string): string {
  return rest.replace(/^\s*[—:-]\s*/, '').trim();
}

/** A sub-ticket heading parsed from the grammar's `subTicket` token (so the reader shares the writer's token),
 *  or null when the line is not one. */
function parseSubTicketHeading(line: string): { index: number; title: string } | null {
  const t = line.trim();
  if (!t.startsWith(EPIC_GRAMMAR.subTicket)) return null;
  const m = SUB_TICKET_SUFFIX.exec(t.slice(EPIC_GRAMMAR.subTicket.length));
  if (m === null) return null;
  return { index: Number(m[1]), title: headingTitle(m[2]) };
}

/** Parse an epic plan into its ordered sub-ticket blocks (each from its heading to the next, the polish report, or
 *  EOF; nothing after the polish report is read), or null when the plan is not an epic. Lenient — `epicPlanWellFormed` is what gates; blocks are kept in authored order,
 *  neither deduplicated nor reordered (§27.10 "copied as authored"). */
export function parseEpicPlan(planText: string): { subTickets: EpicSubTicket[] } | null {
  if (!isEpicPlan(planText)) return null;
  const subTickets: EpicSubTicket[] = [];
  let current: { index: number; title: string; body: string[] } | null = null;
  const flush = (): void => {
    if (current === null) return;
    subTickets.push({ index: current.index, title: current.title, body: current.body.join('\n').trim() });
  };
  for (const line of planText.split('\n')) {
    const heading = parseSubTicketHeading(line);
    if (heading !== null) {
      flush();
      current = { index: heading.index, title: heading.title, body: [] };
      continue;
    }
    if (line.trim() === POLISH_REPORT_HEADING) break;
    if (current !== null) current.body.push(line);
  }
  flush();
  return { subTickets };
}

/** Whether the epic plan meets the MINIMAL contract (§28.5.5): classified an epic, ≥1 sub-ticket block, each
 *  with a non-empty title AND an `Acceptance criteria:` line, and DISTINCT indices — the promotion executor keys
 *  creates on `index`, so a repeat would collapse two slices onto one issue. Tolerates surrounding prose. */
export function epicPlanWellFormed(planText: string): boolean {
  const parsed = parseEpicPlan(planText);
  if (parsed === null || parsed.subTickets.length === 0) return false;
  const indices = new Set(parsed.subTickets.map((t) => t.index));
  if (indices.size !== parsed.subTickets.length) return false;
  return parsed.subTickets.every(
    (t) => t.title.length > 0 && t.body.split('\n').some((l) => l.trim().startsWith(EPIC_GRAMMAR.ac)),
  );
}

/** The one canonical example the predicate test, the fake-agent output, and the recipe few-shot all reference,
 *  so they cannot drift (§93). Asserted `epicPlanWellFormed` by its test. */
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
  return lines.join('\n');
}
