// §27.6 — the consolidator's output: JSON with one writer (the consolidator actor) and
// multiple readers (the completion validator that gates the turn, the branch that reads the verdict + chosen
// roster, the loop-state reader/provider that surface them). One definition in the shared layer so the prompt
// composer (which tells the actor what to write), the completion gate, and the loop-view provider cannot
// drift — the §93 writer↔reader / composed-prompt-is-a-writer pattern. It grades the CLOSED verdict set and
// the roster⊆catalog relationship, never the quality of the judgment (§27.6 Non-goals).

/** The closed set of verdicts the consolidator may emit (§27.6). Spelled once — the type, the parser, and
 *  the well-formedness predicate all derive from this one array so no side can admit a fourth value. */
export const CONSOLIDATOR_VERDICTS = ['clean', 'another round', 'stop for a human'] as const;
export type ConsolidatorVerdict = (typeof CONSOLIDATOR_VERDICTS)[number];

/** The JSON keys of the output. */
export const CONSOLIDATOR_FIELDS = {
  verdict: 'verdict',
  roster: 'roster',
  reason: 'reason',
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

const BYTE_ORDER_MARK = '\uFEFF';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

type Read = { ok: true; doc: Record<string, unknown>; verdict: ConsolidatorVerdict } | { ok: false; problem: string };

function readOutput(text: string): Read {
  const f = CONSOLIDATOR_FIELDS;
  let doc: unknown;
  try {
    doc = JSON.parse(text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text);
  } catch {
    return { ok: false, problem: 'it is not valid JSON' };
  }
  if (!isRecord(doc)) return { ok: false, problem: 'it is not a JSON object' };
  const v = doc[f.verdict];
  if (typeof v !== 'string' || !VERDICT_SET.has(v)) {
    return { ok: false, problem: `its "${f.verdict}" is not exactly one of ${CONSOLIDATOR_VERDICTS.map((x) => `"${x}"`).join(' / ')}` };
  }
  return { ok: true, doc, verdict: v as ConsolidatorVerdict };
}

/** Parse the consolidator output into its verdict, chosen roster, and (for `stop for a human`) reason — or null
 *  when it carries no verdict from the closed set. The well-formedness predicate is what gates the turn; the
 *  branch reads a parse of an already-well-formed output. */
export function parseConsolidatorOutput(text: string): { verdict: ConsolidatorVerdict; roster: string[]; reason: string | null } | null {
  const f = CONSOLIDATOR_FIELDS;
  const read = readOutput(text);
  if (!read.ok) return null;
  const roster = read.doc[f.roster];
  const reason = read.doc[f.reason];
  return {
    verdict: read.verdict,
    roster: Array.isArray(roster) ? roster.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter((p) => p.length > 0) : [],
    reason: typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : null,
  };
}

/** Every defect that keeps the consolidator output from being well-formed (§27.6/AC3): no verdict from the closed
 *  set, or — ONLY under `another round` — a roster that is not a non-empty list of personas the catalog declares
 *  (§27.4). A terminal verdict needs no roster, and a roster supplied on one is ignored. Empty ⟺ well-formed. The
 *  problems are fixed text that never repeats the file's own. Judgment CORRECTNESS is out of scope. */
export function consolidatorOutputProblems(text: string, catalog: string[]): string[] {
  const f = CONSOLIDATOR_FIELDS;
  const read = readOutput(text);
  if (!read.ok) return [read.problem];
  if (read.verdict !== ANOTHER_ROUND) return [];
  const roster = read.doc[f.roster];
  if (!Array.isArray(roster) || roster.length === 0) {
    return [`"${f.verdict}": "${ANOTHER_ROUND}" needs a non-empty "${f.roster}" list naming reviewers from: ${catalog.join(', ')}`];
  }
  const declared = new Set(catalog);
  return roster.flatMap((p: unknown, i) =>
    typeof p === 'string' && declared.has(p.trim()) ? [] : [`"${f.roster}"[${i}] is not in this loop's reviewer catalog: ${catalog.join(', ')}`],
  );
}

/** Whether the consolidator output is well-formed (§27.6/AC3) — exactly when `consolidatorOutputProblems`
 *  finds nothing. */
export function consolidatorOutputWellFormed(text: string, catalog: string[]): boolean {
  return consolidatorOutputProblems(text, catalog).length === 0;
}

/** The single canonical example the predicate test, the fake-agent output and the prompt few-shot all
 *  reference — one per verdict so the consumers cannot drift (§93). `another round` demonstrates a roster;
 *  `stop for a human` demonstrates the reason. */
export function exampleConsolidatorOutput(verdict: ConsolidatorVerdict, catalog: string[]): string {
  const f = CONSOLIDATOR_FIELDS;
  return `${JSON.stringify(
    {
      [f.verdict]: verdict,
      ...(verdict === ANOTHER_ROUND ? { [f.roster]: catalog.length > 0 ? catalog : ['(the catalog is empty — name at least one reviewer)'] } : {}),
      ...(verdictCarriesReason(verdict) ? { [f.reason]: 'a reviewer raised an issue only a human can resolve' } : {}),
    },
    null,
    2,
  )}\n`;
}
