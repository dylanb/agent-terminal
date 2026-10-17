import { describe, expect, it } from 'vitest';
import {
  DISPOSITIONS,
  REPORT_FIELDS,
  REVIEWER_STATUSES,
  exampleRoundReport,
  failedReviewers,
  unloadedReviewers,
  reportHasFailedReviewer,
  reportNeedsAHuman,
  roundReportProblems,
  roundReportWellFormed,
  type RoundReportSpec,
} from '../../src/shared/roundReport';
import { roundReportWithDisposition } from '../helpers/roundReports';

// §27.5 (v2.202) — the round report is JSON with ONE writer (the fixer) and several readers (the completion
// validator, the agent's own check, the clean-guard, the auto gate, the consolidator). It grades structure and
// never quality: the def-declared sections, a record for every roster reviewer with a status from the closed
// set, and each issue's fields with a disposition from the closed set.

const SPEC: RoundReportSpec = { sections: ['summary', 'findings', 'disposition'], roster: ['review-principal', 'review-security'] };

type Issue = Record<string, unknown>;
const issue = (over: Issue = {}): Issue => ({ issue: 'a real defect', disposition: 'fixed', reason: 'it was in scope', whatChanged: 'fixed it', ...over });
const report = (reviewers: unknown[], sections: Record<string, unknown> = { summary: 's', findings: 'f', disposition: 'd' }): string =>
  JSON.stringify({ sections, reviewers });
const ran = (persona: string, issues: Issue[] = []): Record<string, unknown> => ({ persona, status: 'ran', issues });
const withIssue = (i: Issue): string => report([ran('review-principal', [i]), ran('review-security')]);

describe('the canonical example (the one anchor across prompt, tests and e2e)', () => {
  it('is well-formed for a roster and sections', () => {
    expect(roundReportProblems(exampleRoundReport(SPEC), SPEC)).toEqual([]);
  });

  it('is well-formed with an empty roster', () => {
    const spec: RoundReportSpec = { sections: ['summary'], roster: [] };
    expect(roundReportWellFormed(exampleRoundReport(spec), spec)).toBe(true);
  });
});

describe('the report as a whole', () => {
  it.each([
    ['not JSON', '## summary\n\n### review-principal\n\n_no findings_\n', /not valid JSON/],
    ['not an object', '[]', /not a JSON object/],
    ['no sections object', JSON.stringify({ reviewers: [] }), /sections/],
    ['no reviewers list', JSON.stringify({ sections: { summary: '', findings: '', disposition: '' } }), /reviewers/],
  ])('is malformed when it is %s, and says so', (_what, text, problem) => {
    const problems = roundReportProblems(text, SPEC);
    expect(problems.join('\n')).toMatch(problem);
    expect(roundReportWellFormed(text, SPEC)).toBe(false);
  });

  it('reads a report with a byte order mark', () => {
    expect(roundReportWellFormed(`﻿${exampleRoundReport(SPEC)}`, SPEC)).toBe(true);
  });

  it('ignores fields it does not know', () => {
    const r = JSON.stringify({ ...JSON.parse(exampleRoundReport(SPEC)), round: 3, notes: 'x' });
    expect(roundReportWellFormed(r, SPEC)).toBe(true);
  });
});

describe('sections present (AC3)', () => {
  it('names each def-declared section that is missing or not text', () => {
    const problems = roundReportProblems(report([ran('review-principal'), ran('review-security')], { summary: 's', findings: 3 }), SPEC).join('\n');
    expect(problems).toContain('"findings"');
    expect(problems).toContain('"disposition"');
    expect(problems).not.toContain('"summary"');
  });
});

describe('full-roster accounting (AC4, AC5)', () => {
  it('names a roster reviewer with no record', () => {
    const problems = roundReportProblems(report([ran('review-principal'), ran('review-somebody-else')]), SPEC).join('\n');
    expect(problems).toContain('review-security');
    expect(problems).not.toContain('review-principal');
  });

  it('never infers a reviewer from an issue that mentions it', () => {
    const r = report([ran('review-principal', [issue({ issue: 'review-security also flagged this' })])]);
    expect(roundReportWellFormed(r, SPEC)).toBe(false);
  });

  it('accounts for a reviewer that ran and found nothing, failed, or was not loaded', () => {
    for (const status of REVIEWER_STATUSES) {
      expect(roundReportWellFormed(report([ran('review-principal'), { persona: 'review-security', status }]), SPEC)).toBe(true);
    }
  });

  it('is malformed when a reviewer record has a status outside the closed set', () => {
    const problems = roundReportProblems(report([ran('review-principal'), { persona: 'review-security', status: 'skipped' }]), SPEC).join('\n');
    expect(problems).toContain('review-security');
    for (const s of REVIEWER_STATUSES) expect(problems).toContain(s);
  });

  it('is malformed when a roster reviewer is recorded twice', () => {
    expect(roundReportProblems(report([ran('review-principal'), ran('review-security'), ran('review-security')]), SPEC).join('\n')).toMatch(
      /review-security.*more than once/,
    );
  });
});

describe('per-issue fields (AC6)', () => {
  it('accepts an issue carrying issue, disposition, reason and whatChanged', () => {
    expect(roundReportWellFormed(withIssue(issue()), SPEC)).toBe(true);
  });

  it.each([
    ['no disposition', { disposition: undefined }, /disposition/],
    ['no reason', { reason: undefined }, /reason/],
    ['a blank reason', { reason: '  ' }, /reason/],
    ['no issue text', { issue: '' }, /issue/],
    ['a fixed issue with no whatChanged', { whatChanged: undefined }, new RegExp(REPORT_FIELDS.whatChanged)],
  ])('is malformed with %s', (_what, over, problem) => {
    const problems = roundReportProblems(withIssue(issue(over)), SPEC);
    expect(problems.join('\n')).toMatch(problem);
  });

  it('does not require whatChanged for a dismissed issue', () => {
    expect(roundReportWellFormed(withIssue(issue({ disposition: 'dismissed — out of scope', whatChanged: undefined })), SPEC)).toBe(true);
  });

  it('is malformed when an issues entry is not an object, or issues is not a list', () => {
    expect(roundReportWellFormed(report([ran('review-principal', ['a defect' as unknown as Issue]), ran('review-security')]), SPEC)).toBe(false);
    expect(roundReportWellFormed(report([{ persona: 'review-principal', status: 'ran', issues: 'none' }, ran('review-security')]), SPEC)).toBe(false);
  });
});

describe('disposition membership is exact, never normalized (AC6)', () => {
  it('accepts every disposition in the closed set', () => {
    for (const d of DISPOSITIONS) expect(roundReportWellFormed(withIssue(issue({ disposition: d })), SPEC)).toBe(true);
  });

  it.each(['Fixed', 'dismissed - out of scope', 'wontfix', ' fixed '])('rejects %j and lists the allowed values', (d) => {
    const problems = roundReportProblems(withIssue(issue({ disposition: d })), SPEC).join('\n');
    for (const allowed of DISPOSITIONS) expect(problems).toContain(allowed);
  });
});

describe('disposition CORRECTNESS is out of scope (Non-goals)', () => {
  it('completes a report of all `needs a human` exactly as a report of all `fixed`', () => {
    const r = report([ran('review-principal', [issue({ disposition: 'needs a human' })]), ran('review-security', [issue({ disposition: 'needs a human' })])]);
    expect(roundReportWellFormed(r, SPEC)).toBe(true);
  });
});

describe('what it says is wrong', () => {
  it('never repeats text from the report', () => {
    const r = report([ran('review-principal', [issue({ issue: '<script>evil</script>', disposition: 'evil-disposition' })]), { persona: '<script>who</script>', status: 'x' }]);
    const problems = roundReportProblems(r, SPEC).join('\n');
    expect(problems).not.toContain('script');
    expect(problems).not.toContain('evil');
  });

  it('agrees with roundReportWellFormed', () => {
    for (const r of [exampleRoundReport(SPEC), '', withIssue(issue({ reason: undefined }))]) {
      expect(roundReportWellFormed(r, SPEC)).toBe(roundReportProblems(r, SPEC).length === 0);
    }
  });
});

describe('failed reviewers (§27.5/AC7 — the signal the clean-guard keys on)', () => {
  const withStatuses = (principal: unknown, security: unknown): string =>
    report([{ persona: 'review-principal', status: principal, issues: [] }, { persona: 'review-security', status: security, issues: [] }]);

  it('names each reviewer recorded as failed', () => {
    expect(failedReviewers(withStatuses('failed', 'ran'))).toEqual(['review-principal']);
    expect(reportHasFailedReviewer(withStatuses('failed', 'ran'))).toBe(true);
    expect(new Set(failedReviewers(withStatuses('failed', 'failed')))).toEqual(new Set(['review-principal', 'review-security']));
  });

  it('a reviewer that ran, even one that raised `needs a human`, is not failed', () => {
    const r = report([ran('review-principal', [issue({ disposition: 'needs a human' })]), ran('review-security')]);
    expect(failedReviewers(r)).toEqual([]);
    expect(reportHasFailedReviewer(r)).toBe(false);
  });

  it('names no one in a report that is not JSON', () => {
    expect(failedReviewers('### review-principal\n\n_failed to run_\n')).toEqual([]);
  });
});

describe('not-loaded reviewers (§27.4 — a reviewer the agent session cannot spawn)', () => {
  it('names each reviewer recorded as not loaded, and keeps the report well-formed', () => {
    const r = report([{ persona: 'review-principal', status: 'not loaded' }, ran('review-security')]);
    expect(unloadedReviewers(r)).toEqual(['review-principal']);
    expect(roundReportWellFormed(r, SPEC)).toBe(true);
  });

  it('names no reviewer when every record ran or failed', () => {
    expect(unloadedReviewers(report([ran('review-principal'), { persona: 'review-security', status: 'failed' }]))).toEqual([]);
  });
});

describe('the closed sets are spec-fixed', () => {
  it('the dispositions are exactly the §27.5 four', () => {
    expect(DISPOSITIONS).toEqual(['fixed', 'dismissed — out of scope', 'dismissed — invalid', 'needs a human']);
  });
});

// §27.9.1 N9b.6(a) — AC3 (#137 S2): the one predicate the gate controller reads a round report's `needs a human` through.
describe('reportNeedsAHuman — whether a round report records a `needs a human` disposition', () => {
  it('is true when an issue carries `needs a human`', () => {
    expect(reportNeedsAHuman(roundReportWithDisposition(['summary'], SPEC.roster, 'needs a human'))).toBe(true);
  });

  it('is false when every issue carries a settled disposition, and for a report with no issues', () => {
    expect(reportNeedsAHuman(roundReportWithDisposition(['summary'], SPEC.roster, 'fixed'))).toBe(false);
    expect(reportNeedsAHuman(exampleRoundReport(SPEC))).toBe(false);
  });

  it.each([
    ['an issue disposition outside the closed set', withIssue(issue({ disposition: 'maybe later' }))],
    ['a report that is not JSON', '- issue: x\n  disposition: needs a human\n'],
    ['a reviewer list that is not a list', JSON.stringify({ sections: {}, reviewers: {} })],
  ])('is null for %s, so the caller fails toward (a)', (_what, r) => {
    expect(reportNeedsAHuman(r)).toBeNull();
  });
});
