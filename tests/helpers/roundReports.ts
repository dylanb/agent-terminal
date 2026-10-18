import { FIXED_DISPOSITION, type Disposition, type ReviewerStatus } from '../../src/shared/roundReport';

/** One issue a scripted round records, exactly as the round report carries it: the disposition is whatever text
 *  the agent wrote, so a script can record one outside the closed set. */
export interface ScriptedIssue {
  issue: string;
  disposition: string;
  reason: string;
  whatChanged?: string;
}

/** A §27.5 round report whose first roster persona raises `issues`, every other persona having run and found
 *  nothing. */
export function roundReportWithIssues(sections: string[], roster: string[], issues: ScriptedIssue[]): string {
  return `${JSON.stringify(
    {
      sections: Object.fromEntries(sections.map((s) => [s, `(${s})`])),
      reviewers: roster.map((persona, idx) => ({ persona, status: 'ran', issues: idx === 0 ? issues : [] })),
    },
    null,
    2,
  )}\n`;
}

/** A §27.5 round report whose first roster persona raises one issue carrying `disposition`, every other
 *  persona having run and found nothing. */
export function roundReportWithDisposition(sections: string[], roster: string[], disposition: Disposition): string {
  const persona = roster[0] ?? '';
  return roundReportWithIssues(sections, roster, [
    {
      issue: `a sample issue raised by ${persona}`,
      disposition,
      reason: 'the scripted disposition for this round',
      ...(disposition === FIXED_DISPOSITION ? { whatChanged: 'corrected the defect' } : {}),
    },
  ]);
}

/** A §27.5 round report in which every roster persona ran and found nothing, except those `statuses` names. */
export function roundReportWithStatuses(sections: string[], roster: string[], statuses: Partial<Record<string, ReviewerStatus>>): string {
  return `${JSON.stringify(
    {
      sections: Object.fromEntries(sections.map((s) => [s, `(${s})`])),
      reviewers: roster.map((persona) => ({ persona, status: statuses[persona] ?? 'ran', issues: [] })),
    },
    null,
    2,
  )}\n`;
}
