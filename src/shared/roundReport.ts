// §27.5 — the round report: a serialized Markdown vocabulary with one writer (the fixer) and multiple
// readers (this slice's completion validator, N4's consolidator). One definition in the shared layer so the
// prompt composer (which tells the fixer what to write) and the predicate (which validates it) cannot drift.

import { fieldBlock, fieldValue } from './markdownFields';

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
  failedMarker: string;
}

export const REPORT_GRAMMAR: ReportGrammar = {
  sectionPrefix: '## ',
  personaPrefix: '### ',
  issueLabel: 'issue',
  dispositionLabel: 'disposition',
  reasonLabel: 'reason',
  whatChangedLabel: 'what-changed',
  emptyMarker: '_no findings_',
  failedMarker: '_failed to run_',
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
    const issue = fieldBlock(lines, i, g.issueLabel);
    if (issue !== null) {
      const block: IssueBlock = { hasPersona: currentPersona !== null, issue: issue.value, disposition: null, reason: null, whatChanged: null };
      let j = issue.end;
      while (j < lines.length) {
        if (fieldValue(lines[j], g.issueLabel) !== null) break;
        if (isHeading(lines[j], g.personaPrefix) !== null || isHeading(lines[j], g.sectionPrefix) !== null) break;
        const d = fieldBlock(lines, j, g.dispositionLabel);
        const r = fieldBlock(lines, j, g.reasonLabel);
        const w = fieldBlock(lines, j, g.whatChangedLabel);
        if (d !== null) block.disposition = d.value;
        if (r !== null) block.reason = r.value;
        if (w !== null) block.whatChanged = w.value;
        j = (d ?? r ?? w)?.end ?? j + 1;
      }
      if (!issueWellFormed(block)) return false;
      i = j - 1;
    }
  }

  for (const s of spec.sections) if (!sectionsPresent.has(s)) return false;
  for (const p of spec.roster) if (!personasPresent.has(p)) return false;
  return true;
}

/** The personas a round report records as having FAILED TO RUN (§27.5/AC7): each persona whose record
 *  carries the single-sourced failed marker as a line of its own. Distinct from a persona that RAN and found
 *  nothing (the empty marker) or one that RAN and raised issues (a `needs a human` disposition is a raised
 *  issue, never a failed lens). The marker is only recognized inside a persona record — prose outside one is
 *  never mistaken for it — so the engine's clean-guard reads the same grammar the validator single-sources. */
export function failedReviewers(report: string): string[] {
  const g = REPORT_GRAMMAR;
  const failed: string[] = [];
  let currentPersona: string | null = null;
  for (const line of report.split('\n')) {
    const persona = isHeading(line, g.personaPrefix);
    if (persona !== null) {
      currentPersona = persona;
      continue;
    }
    if (isHeading(line, g.sectionPrefix) !== null) {
      currentPersona = null;
      continue;
    }
    if (currentPersona !== null && line.trim() === g.failedMarker && !failed.includes(currentPersona)) {
      failed.push(currentPersona);
    }
  }
  return failed;
}

/** Whether the round report records ANY reviewer as failed to run (§27.5/AC7) — the boolean the engine's
 *  clean-guard keys on. A round with a failed lens is never presented clean, even if the consolidator emits
 *  `clean`; a raised `needs a human` issue is the consolidator's territory, not a failed lens. */
export function reportHasFailedReviewer(report: string): boolean {
  return failedReviewers(report).length > 0;
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
