import { describe, expect, it } from 'vitest';
import { DISPOSITIONS, REVIEWER_STATUSES, failedReviewers, roundReportProblems, unloadedReviewers } from '../../src/shared/roundReport';
import { roundReportWithDisposition, roundReportWithStatuses } from '../helpers/roundReports';

const spec = { sections: ['Summary', 'Findings'], roster: ['security', 'tests', 'ux'] };

describe('roundReportWithDisposition', () => {
  it.each(DISPOSITIONS)('builds a well-formed round report whose one issue carries `%s`', (disposition) => {
    const report = roundReportWithDisposition(spec.sections, spec.roster, disposition);
    expect(roundReportProblems(report, spec)).toEqual([]);
    const doc = JSON.parse(report) as { reviewers: { issues: { disposition: string }[] }[] };
    expect(doc.reviewers.flatMap((r) => r.issues.map((i) => i.disposition))).toEqual([disposition]);
  });
});

describe('roundReportWithStatuses', () => {
  it.each(REVIEWER_STATUSES)('builds a well-formed round report recording one reviewer as `%s`', (status) => {
    const report = roundReportWithStatuses(spec.sections, spec.roster, { tests: status });
    expect(roundReportProblems(report, spec)).toEqual([]);
    expect(failedReviewers(report)).toEqual(status === 'failed' ? ['tests'] : []);
    expect(unloadedReviewers(report)).toEqual(status === 'not loaded' ? ['tests'] : []);
  });
});
