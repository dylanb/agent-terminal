import { describe, expect, it } from 'vitest';
import { DISPOSITIONS, REPORT_GRAMMAR, roundReportProblems } from '../../src/shared/roundReport';
import { roundReportWithDisposition } from '../helpers/roundReports';

const spec = { sections: ['Summary', 'Findings'], roster: ['security', 'tests', 'ux'] };

describe('roundReportWithDisposition', () => {
  it.each(DISPOSITIONS)('builds a well-formed round report whose one issue carries `%s`', (disposition) => {
    const report = roundReportWithDisposition(spec.sections, spec.roster, disposition);
    expect(roundReportProblems(report, spec)).toEqual([]);
    const dispositions = report
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith(`${REPORT_GRAMMAR.dispositionLabel}:`))
      .map((l) => l.slice(REPORT_GRAMMAR.dispositionLabel.length + 1).trim());
    expect(dispositions).toEqual([disposition]);
  });
});
