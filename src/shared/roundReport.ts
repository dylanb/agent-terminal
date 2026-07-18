// §27.5 — the round report: a serialized Markdown vocabulary with one writer (the fixer) and multiple
// readers (this slice's completion validator, N4's consolidator). One definition in the shared layer so the
// prompt composer (which tells the fixer what to write) and the predicate (which validates it) cannot drift.

export const DISPOSITIONS = ['fixed', 'dismissed — out of scope', 'dismissed — invalid', 'needs a human'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** The one disposition that carries extra validation semantics (a `fixed` issue must record what changed) and
 *  anchors the canonical example — spelled once so it cannot desync from DISPOSITIONS. */
export const FIXED_DISPOSITION: Disposition = 'fixed';

/** The report grammar both sides agree on: heading prefixes, per-issue element labels, and the empty/failed
 *  persona marker. It pins the names/tokens, not a rigid layout — an over-constrained template would diverge
 *  the fake-agent from the real fixer (§27.5 Risks). */
export interface ReportGrammar {
  sectionPrefix: string;
  personaPrefix: string;
  issueLabel: string;
  dispositionLabel: string;
  reasonLabel: string;
  whatChangedLabel: string;
  emptyMarker: string;
}

export const REPORT_GRAMMAR: ReportGrammar = {
  sectionPrefix: '## ',
  personaPrefix: '### ',
  issueLabel: 'issue',
  dispositionLabel: 'disposition',
  reasonLabel: 'reason',
  whatChangedLabel: 'what-changed',
  emptyMarker: '_no findings_',
};

/** The def-declared sections and the round's roster, as primitive string vocabulary — never the parsed-def
 *  types that live in main (the injection seam names the domain concept, not the shape behind it). */
export interface RoundReportSpec {
  sections: string[];
  roster: string[];
}

const DISPOSITION_SET: ReadonlySet<string> = new Set(DISPOSITIONS);

function isHeading(line: string, prefix: string): string | null {
  const t = line.trim();
  return t.startsWith(prefix) ? t.slice(prefix.length).trim() : null;
}

function fieldValue(line: string, label: string): string | null {
  let t = line.trim();
  if (t.startsWith('-')) t = t.slice(1).trimStart();
  const idx = t.indexOf(':');
  if (idx < 0) return null;
  return t.slice(0, idx).trim() === label ? t.slice(idx + 1).trim() : null;
}

interface IssueBlock {
  hasPersona: boolean;
  issue: string;
  disposition: string | null;
  reason: string | null;
  whatChanged: string | null;
}

function issueWellFormed(block: IssueBlock): boolean {
  if (!block.hasPersona) return false; // AC6 — the persona is carried by the enclosing record
  if (block.issue === '') return false;
  if (block.disposition === null || !DISPOSITION_SET.has(block.disposition)) return false; // exact, trimmed, never normalized
  if (block.reason === null || block.reason === '') return false;
  if (block.disposition === FIXED_DISPOSITION && (block.whatChanged === null || block.whatChanged === '')) return false;
  return true;
}

/** Whether the report is well-formed (§27.5/§27.12): def-declared sections present, every recorded issue's
 *  required elements present with a disposition from the closed set (exact match, surrounding whitespace
 *  trimmed — never normalized), and every roster persona accounted for by a persona-keyed record
 *  (present-vs-absent; a zero-issue persona is present via its record, distinct from absent). Disposition
 *  CORRECTNESS is out of scope. */
export function roundReportWellFormed(report: string, spec: RoundReportSpec): boolean {
  const lines = report.split('\n');
  const sectionsPresent = new Set<string>();
  const personasPresent = new Set<string>();
  const g = REPORT_GRAMMAR;

  let currentPersona: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const persona = isHeading(lines[i], g.personaPrefix);
    if (persona !== null) {
      personasPresent.add(persona);
      currentPersona = persona;
      continue;
    }
    const section = isHeading(lines[i], g.sectionPrefix);
    if (section !== null) {
      sectionsPresent.add(section);
      currentPersona = null;
      continue;
    }
    const issue = fieldValue(lines[i], g.issueLabel);
    if (issue !== null) {
      const block: IssueBlock = { hasPersona: currentPersona !== null, issue, disposition: null, reason: null, whatChanged: null };
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (fieldValue(lines[j], g.issueLabel) !== null) break;
        if (isHeading(lines[j], g.personaPrefix) !== null || isHeading(lines[j], g.sectionPrefix) !== null) break;
        const d = fieldValue(lines[j], g.dispositionLabel);
        if (d !== null) block.disposition = d;
        const r = fieldValue(lines[j], g.reasonLabel);
        if (r !== null) block.reason = r;
        const w = fieldValue(lines[j], g.whatChangedLabel);
        if (w !== null) block.whatChanged = w;
      }
      if (!issueWellFormed(block)) return false;
      i = j - 1;
    }
  }

  for (const s of spec.sections) if (!sectionsPresent.has(s)) return false;
  for (const p of spec.roster) if (!personasPresent.has(p)) return false;
  return true;
}

/** The single canonical example the predicate happy-path test, the fake-agent e2e output, and the prompt
 *  few-shot all reference — one artifact so the four consumers cannot drift (§27.5). The first roster
 *  persona demonstrates a fixed issue with every element; the rest carry the explicit empty marker. */
export function exampleRoundReport(spec: RoundReportSpec): string {
  const g = REPORT_GRAMMAR;
  const parts: string[] = ['# Round report', ''];
  for (const s of spec.sections) parts.push(`${g.sectionPrefix}${s}`, '', `(${s})`, '');
  spec.roster.forEach((persona, idx) => {
    parts.push(`${g.personaPrefix}${persona}`, '');
    if (idx === 0) {
      parts.push(
        `- ${g.issueLabel}: a sample issue raised by ${persona}`,
        `  ${g.dispositionLabel}: ${FIXED_DISPOSITION}`,
        `  ${g.reasonLabel}: it was a real in-scope defect`,
        `  ${g.whatChangedLabel}: corrected the defect`,
        '',
      );
    } else {
      parts.push(g.emptyMarker, '');
    }
  });
  return `${parts.join('\n')}\n`;
}
