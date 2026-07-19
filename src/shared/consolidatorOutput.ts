// §27.6 — the consolidator's output: a serialized vocabulary with one writer (the consolidator actor) and
// multiple readers (the completion validator that gates the turn, the branch that reads the verdict + chosen
// roster, the loop-state reader/provider that surface them). One definition in the shared layer so the prompt
// composer (which tells the actor what to write), the completion gate, and the loop-view provider cannot
// drift — the §93 writer↔reader / composed-prompt-is-a-writer pattern. It grades the CLOSED verdict set and
// the roster⊆catalog relationship, never the quality of the judgment (§27.6 Non-goals).

/** The closed set of verdicts the consolidator may emit (§27.6). Spelled once — the type, the parser, and
 *  the well-formedness predicate all derive from this one array so no side can admit a fourth value. */
export const CONSOLIDATOR_VERDICTS = ['clean', 'another round', 'stop for a human'] as const;
export type ConsolidatorVerdict = (typeof CONSOLIDATOR_VERDICTS)[number];

/** The output grammar both sides agree on: the labelled lines the actor writes and the parser reads. Pins
 *  the token names, not a rigid layout — an over-constrained template would diverge the fake-agent from the
 *  real consolidator (mirrors the round-report grammar). */
export const CONSOLIDATOR_GRAMMAR = {
  verdictLabel: 'verdict',
  rosterLabel: 'roster',
  reasonLabel: 'reason',
} as const;

const VERDICT_SET: ReadonlySet<string> = new Set(CONSOLIDATOR_VERDICTS);
const ANOTHER_ROUND: ConsolidatorVerdict = 'another round';
const STOP_FOR_A_HUMAN: ConsolidatorVerdict = 'stop for a human';

/** The persisted verdict/`reason` gate (§27.6): a `reason` belongs to the output ONLY under
 *  `stop for a human`, mirroring the `error_reason` writer↔reader gate — defined once so the loop-state
 *  reader and the loop-view provider cannot present a different verdict/`reason` pairing. */
export function verdictCarriesReason(verdict: ConsolidatorVerdict): boolean {
  return verdict === STOP_FOR_A_HUMAN;
}

function labelledValue(line: string, label: string): string | null {
  const t = line.trim();
  const idx = t.indexOf(':');
  if (idx < 0) return null;
  return t.slice(0, idx).trim() === label ? t.slice(idx + 1).trim() : null;
}

/** Split a `roster:` value into personas (comma-separated; a persona name carries no comma). Empty entries
 *  are dropped so a trailing comma or a blank value yields an empty roster, not a phantom empty persona. */
function parseRoster(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse the consolidator output into its verdict, chosen roster, and (for `stop for a human`) reason —
 *  or null when no line carries a verdict from the closed set. Lenient on structure (the well-formedness
 *  predicate is what gates the turn); the branch reads a parse of an already-well-formed output. */
export function parseConsolidatorOutput(text: string): { verdict: ConsolidatorVerdict; roster: string[]; reason: string | null } | null {
  const g = CONSOLIDATOR_GRAMMAR;
  let verdict: ConsolidatorVerdict | null = null;
  let roster: string[] = [];
  let reason: string | null = null;
  for (const line of text.split('\n')) {
    const v = labelledValue(line, g.verdictLabel);
    if (v !== null && VERDICT_SET.has(v)) verdict = v as ConsolidatorVerdict;
    const r = labelledValue(line, g.rosterLabel);
    if (r !== null) roster = parseRoster(r);
    const rs = labelledValue(line, g.reasonLabel);
    if (rs !== null && rs.length > 0) reason = rs;
  }
  if (verdict === null) return null;
  return { verdict, roster, reason };
}

/** Whether the consolidator output is well-formed (§27.6/AC3): it carries a verdict from the closed set and
 *  — ONLY when the verdict is `another round` — a non-empty roster drawn from the catalog (§27.4: a persona
 *  the catalog does not declare can never be invoked). A terminal verdict (`clean`/`stop for a human`) needs
 *  no roster, and a roster supplied on one is ignored, not malformed. Judgment CORRECTNESS is out of scope. */
export function consolidatorOutputWellFormed(text: string, catalog: string[]): boolean {
  const parsed = parseConsolidatorOutput(text);
  if (parsed === null) return false;
  if (parsed.verdict !== ANOTHER_ROUND) return true;
  if (parsed.roster.length === 0) return false;
  const declared = new Set(catalog);
  return parsed.roster.every((p) => declared.has(p));
}

/** The single canonical example the predicate happy-path test, the fake-agent output, and the prompt
 *  few-shot all reference — one artifact per verdict so the consumers cannot drift (§93). `another round`
 *  demonstrates a subset roster; `stop for a human` demonstrates the reason line. */
export function exampleConsolidatorOutput(verdict: ConsolidatorVerdict, catalog: string[]): string {
  const g = CONSOLIDATOR_GRAMMAR;
  const lines = ['# Consolidator verdict', '', `${g.verdictLabel}: ${verdict}`];
  if (verdict === ANOTHER_ROUND) {
    const roster = catalog.length > 0 ? catalog : ['(the catalog is empty — name at least one reviewer)'];
    lines.push(`${g.rosterLabel}: ${roster.join(', ')}`);
  }
  if (verdictCarriesReason(verdict)) {
    lines.push(`${g.reasonLabel}: a reviewer raised an issue only a human can resolve`);
  }
  return `${lines.join('\n')}\n`;
}
