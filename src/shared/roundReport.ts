// §27.5 — the round report: JSON with one writer (the fixer) and several readers (the completion validator, the
// agent's own check, the clean-guard, the auto gate). One definition in the shared layer so the prompt composer
// (which tells the fixer what to write) and the predicate (which validates it) cannot drift.

import { isJsonRecord as isRecord, readJsonObject } from './jsonArtifact';

export const DISPOSITIONS = ['fixed', 'dismissed — out of scope', 'dismissed — invalid', 'needs a human'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** The one disposition that carries extra validation semantics (a `fixed` issue must record what changed) and
 *  anchors the canonical example — spelled once so it cannot desync from DISPOSITIONS. */
export const FIXED_DISPOSITION: Disposition = 'fixed';

/** The disposition a deferred polish finding takes (§27.8 `polish: defer`). */
export const OUT_OF_SCOPE_DISPOSITION: Disposition = 'dismissed — out of scope';

/** The disposition a finding that is not a defect takes (§27.6). */
export const INVALID_DISPOSITION: Disposition = 'dismissed — invalid';

/** The disposition a fix the loop is not entitled to make takes (§27.3 document-subject overreach). */
export const NEEDS_HUMAN_DISPOSITION: Disposition = 'needs a human';

/** Whether a reviewer ran (and raised its issues, possibly none), failed to run, or could not be spawned
 *  because this agent session started before it was installed (§27.4/§27.5). */
export const REVIEWER_STATUSES = ['ran', 'failed', 'not loaded'] as const;
export type ReviewerStatus = (typeof REVIEWER_STATUSES)[number];

export const RAN_STATUS: ReviewerStatus = 'ran';
export const FAILED_STATUS: ReviewerStatus = 'failed';
export const NOT_LOADED_STATUS: ReviewerStatus = 'not loaded';

export const REPORT_FIELDS = {
  sections: 'sections',
  reviewers: 'reviewers',
  persona: 'persona',
  status: 'status',
  issues: 'issues',
  issue: 'issue',
  disposition: 'disposition',
  reason: 'reason',
  whatChanged: 'whatChanged',
} as const;

/** The def-declared sections and the round's roster, as primitive string vocabulary — never the parsed-def
 *  types that live in main (the injection seam names the domain concept, not the shape behind it). */
export interface RoundReportSpec {
  sections: string[];
  roster: string[];
}

interface ReviewerRecord {
  persona: string;
  status: ReviewerStatus;
  dispositions: Disposition[];
}

/** `unreadable`: some reviewer record or issue disposition could not be read, so a reading of the report as a
 *  whole (whether it needs a human) cannot be trusted. */
type Read = { ok: true; doc: Record<string, unknown>; reviewers: ReviewerRecord[]; problems: string[]; unreadable: boolean } | { ok: false; problem: string };

const DISPOSITION_SET: ReadonlySet<string> = new Set(DISPOSITIONS);
const STATUS_SET: ReadonlySet<string> = new Set(REVIEWER_STATUSES);
const quoted = (items: readonly string[]): string => items.map((d) => `"${d}"`).join(' / ');

const hasText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function issueProblems(v: unknown, at: string): { problems: string[]; disposition: Disposition | null } {
  const f = REPORT_FIELDS;
  if (!isRecord(v)) return { problems: [`${at} is not a JSON object`], disposition: null };
  const problems: string[] = [];
  if (!hasText(v[f.issue])) problems.push(`${at} has no "${f.issue}" text`);
  const d = v[f.disposition];
  const disposition = typeof d === 'string' && DISPOSITION_SET.has(d) ? (d as Disposition) : null;
  if (disposition === null) problems.push(`${at}'s "${f.disposition}" is not exactly one of ${quoted(DISPOSITIONS)}`);
  if (!hasText(v[f.reason])) problems.push(`${at} has no "${f.reason}" text`);
  if (disposition === FIXED_DISPOSITION && !hasText(v[f.whatChanged])) problems.push(`${at} is "${FIXED_DISPOSITION}" but has no "${f.whatChanged}" text`);
  return { problems, disposition };
}

/** The report read, with each defect in it named by position (and by persona only when the roster names it), so
 *  nothing the file says is ever repeated back. */
function readReport(text: string, roster: readonly string[]): Read {
  const f = REPORT_FIELDS;
  const json = readJsonObject(text);
  if (!json.ok) return json;
  const { doc } = json;
  const list = doc[f.reviewers];
  if (!Array.isArray(list)) return { ok: false, problem: `its "${f.reviewers}" is not a list` };
  const known = new Set(roster);
  const problems: string[] = [];
  const reviewers: ReviewerRecord[] = [];
  let unreadable = false;
  list.forEach((v: unknown, i) => {
    const name = isRecord(v) ? v[f.persona] : undefined;
    const persona = typeof name === 'string' ? name : null;
    const at = `${f.reviewers}[${i}]${persona !== null && known.has(persona) ? ` (${persona})` : ''}`;
    if (!isRecord(v) || persona === null) {
      problems.push(`${at} has no "${f.persona}" name`);
      unreadable = true;
      return;
    }
    const s = v[f.status];
    if (typeof s !== 'string' || !STATUS_SET.has(s)) {
      problems.push(`${at}'s "${f.status}" is not exactly one of ${quoted(REVIEWER_STATUSES)}`);
      unreadable = true;
      return;
    }
    const issues = v[f.issues];
    if (!Array.isArray(issues)) {
      problems.push(`${at}'s "${f.issues}" is not a list`);
      unreadable = true;
      return;
    }
    const dispositions: Disposition[] = [];
    issues.forEach((issue: unknown, j) => {
      const read = issueProblems(issue, `${at} ${f.issues}[${j}]`);
      problems.push(...read.problems);
      if (read.disposition === null) unreadable = true;
      else dispositions.push(read.disposition);
    });
    reviewers.push({ persona, status: s as ReviewerStatus, dispositions });
  });
  return { ok: true, doc, reviewers, problems, unreadable };
}

/** Every defect that keeps the report from being well-formed (§27.5/§27.12): a def-declared section missing, a
 *  roster persona with no record or more than one, and each record or issue missing a required field or carrying
 *  a value outside its closed set (exact match, never normalized). Empty ⟺ well-formed. Disposition CORRECTNESS
 *  is out of scope. The problems are fixed text that never repeats the file's own. */
export function roundReportProblems(report: string, spec: RoundReportSpec): string[] {
  const f = REPORT_FIELDS;
  const read = readReport(report, spec.roster);
  if (!read.ok) return [read.problem];
  const sections = read.doc[f.sections];
  const problems = [...read.problems];
  if (!isRecord(sections)) problems.push(`its "${f.sections}" is not a JSON object`);
  else for (const s of spec.sections) if (typeof sections[s] !== 'string') problems.push(`its "${f.sections}" has no "${s}" text`);
  for (const p of spec.roster) {
    const n = read.reviewers.filter((r) => r.persona === p).length;
    if (n === 0) problems.push(`its "${f.reviewers}" has no record for ${p}`);
    if (n > 1) problems.push(`its "${f.reviewers}" records ${p} more than once`);
  }
  return problems;
}

/** Whether the report is well-formed (§27.5/§27.12) — exactly when `roundReportProblems` finds nothing. */
export function roundReportWellFormed(report: string, spec: RoundReportSpec): boolean {
  return roundReportProblems(report, spec).length === 0;
}

/** §27.9.1 N9b.6(a) — whether the report records any issue with the `needs a human` disposition; `null` when the
 *  report's reviewers or any issue's disposition cannot be read. */
export function reportNeedsAHuman(report: string): boolean | null {
  const read = readReport(report, []);
  if (!read.ok || read.unreadable) return null;
  return read.reviewers.some((r) => r.dispositions.includes(NEEDS_HUMAN_DISPOSITION));
}

/** Only `roster` personas are returned, so the names a caller repeats or spawns come from the def, never the file. */
function reviewersWith(report: string, status: ReviewerStatus, roster: readonly string[]): string[] {
  const read = readReport(report, roster);
  if (!read.ok) return [];
  const recorded = new Set(read.reviewers.filter((r) => r.status === status).map((r) => r.persona));
  return roster.filter((p) => recorded.has(p));
}

/** The personas a round report records as having FAILED TO RUN (§27.5/AC7) — distinct from a persona that ran and
 *  found nothing or ran and raised issues (a `needs a human` disposition is a raised issue, never a failed lens). */
export function failedReviewers(report: string, roster: readonly string[]): string[] {
  return reviewersWith(report, FAILED_STATUS, roster);
}

/** §27.4 — the personas whose sub-agent type this agent session could not spawn. */
export function unloadedReviewers(report: string, roster: readonly string[]): string[] {
  return reviewersWith(report, NOT_LOADED_STATUS, roster);
}

/** The single canonical example the predicate test, the fake-agent e2e output and the prompt few-shot all
 *  reference (§27.5). The first roster persona demonstrates a fixed issue with every field; the rest ran and
 *  found nothing. */
export function exampleRoundReport(spec: RoundReportSpec): string {
  const f = REPORT_FIELDS;
  return `${JSON.stringify(
    {
      [f.sections]: Object.fromEntries(spec.sections.map((s) => [s, `(${s})`])),
      [f.reviewers]: spec.roster.map((persona, idx) => ({
        [f.persona]: persona,
        [f.status]: RAN_STATUS,
        [f.issues]:
          idx === 0
            ? [
                {
                  [f.issue]: `a sample issue raised by ${persona}`,
                  [f.disposition]: FIXED_DISPOSITION,
                  [f.reason]: 'it was a real in-scope defect',
                  [f.whatChanged]: 'corrected the defect',
                },
              ]
            : [],
      })),
    },
    null,
    2,
  )}\n`;
}
