import { FIXED_DISPOSITION, REPORT_GRAMMAR, type Disposition } from '../../src/shared/roundReport';

/** A §27.5 round report whose first roster persona raises one issue carrying `disposition`, every other
 *  persona recording the empty marker. */
export function roundReportWithDisposition(sections: string[], roster: string[], disposition: Disposition): string {
  const g = REPORT_GRAMMAR;
  const parts: string[] = ['# Round report', ''];
  for (const s of sections) parts.push(`${g.sectionPrefix}${s}`, '', `(${s})`, '');
  roster.forEach((persona, idx) => {
    parts.push(`${g.personaPrefix}${persona}`, '');
    if (idx === 0) {
      parts.push(
        `- ${g.issueLabel}: a sample issue raised by ${persona}`,
        `  ${g.dispositionLabel}: ${disposition}`,
        `  ${g.reasonLabel}: the scripted disposition for this round`,
      );
      if (disposition === FIXED_DISPOSITION) parts.push(`  ${g.whatChangedLabel}: corrected the defect`);
      parts.push('');
    } else {
      parts.push(g.emptyMarker, '');
    }
  });
  return `${parts.join('\n')}\n`;
}
