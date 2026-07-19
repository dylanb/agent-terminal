import { describe, expect, it } from 'vitest';
import {
  DISPOSITIONS,
  REPORT_GRAMMAR,
  exampleRoundReport,
  failedReviewers,
  reportHasFailedReviewer,
  roundReportWellFormed,
  type RoundReportSpec,
} from '../../src/shared/roundReport';

// §27.5 — the round report is a serialized Markdown vocabulary with ONE writer (the fixer) and multiple
// readers (this slice's completion validator, N4's consolidator). The well-formedness predicate lives once
// in the shared layer, receiving the def-declared section names and the roster as primitive string lists
// (the injection seam names a domain concept, not the parsed-def shape behind it). It grades three
// structural things and never quality: def-declared sections present, per-issue elements present with a
// disposition from the closed set (exact match, trimmed — never normalized), and full-roster accounting.

const SPEC: RoundReportSpec = { sections: ['summary', 'findings', 'disposition'], roster: ['review-principal', 'review-security'] };

describe('roundReportWellFormed — the canonical example (the one anchor across prompt/tests/e2e/N4)', () => {
  it('accepts the generated canonical example for a roster + sections', () => {
    expect(roundReportWellFormed(exampleRoundReport(SPEC), SPEC)).toBe(true);
  });

  it('accepts a report with an empty roster + sections (no persona records required)', () => {
    const spec: RoundReportSpec = { sections: ['summary'], roster: [] };
    expect(roundReportWellFormed(exampleRoundReport(spec), spec)).toBe(true);
  });
});

describe('roundReportWellFormed — sections present (AC3)', () => {
  it('is malformed when a def-declared section is absent', () => {
    const report = exampleRoundReport(SPEC).replace('## disposition', '## dispositions'); // typo → section absent
    expect(roundReportWellFormed(report, SPEC)).toBe(false);
  });
});

describe('roundReportWellFormed — full-roster accounting (AC4, AC5)', () => {
  it('is malformed when a roster persona has no record (present-vs-absent → absent)', () => {
    const report = exampleRoundReport(SPEC).replace('### review-security', '### review-somebody-else');
    expect(roundReportWellFormed(report, SPEC)).toBe(false);
  });

  it('accounts for a persona that recorded nothing via an explicit empty marker (present-empty ≠ absent)', () => {
    // review-security carries only the empty marker in the canonical example; it is accounted-for.
    expect(roundReportWellFormed(exampleRoundReport(SPEC), SPEC)).toBe(true);
    // Dropping its header (not just its issues) is the absent case → malformed.
    const dropped = exampleRoundReport(SPEC).replace(/### review-security[\s\S]*?(?=\n## |\n$)/, '');
    expect(roundReportWellFormed(dropped, SPEC)).toBe(false);
  });

  it('never infers a persona from issues attributed to it — a record keyed to the persona is required', () => {
    // A report that mentions review-security only inside another persona's issue text does NOT account for it.
    const report =
      '## summary\n\n## findings\n\n### review-principal\n\n' +
      '- issue: review-security also flagged this\n  disposition: fixed\n  reason: r\n  what-changed: c\n\n' +
      '## disposition\n\ndone\n';
    expect(roundReportWellFormed(report, SPEC)).toBe(false);
  });
});

describe('roundReportWellFormed — per-issue elements (AC6)', () => {
  const withIssue = (block: string): string =>
    `## summary\n\n## findings\n\n### review-principal\n\n${block}\n### review-security\n\n${REPORT_GRAMMAR.emptyMarker}\n\n## disposition\n\ndone\n`;

  it('accepts an issue carrying persona (header), issue, disposition, reason, and what-changed', () => {
    const block = '- issue: a real defect\n  disposition: fixed\n  reason: it was in scope\n  what-changed: fixed it\n';
    expect(roundReportWellFormed(withIssue(block), SPEC)).toBe(true);
  });

  it('is malformed when a recorded issue omits its disposition', () => {
    const block = '- issue: a real defect\n  reason: it was in scope\n  what-changed: fixed it\n';
    expect(roundReportWellFormed(withIssue(block), SPEC)).toBe(false);
  });

  it('is malformed when a recorded issue omits its reason', () => {
    const block = '- issue: a real defect\n  disposition: fixed\n  what-changed: fixed it\n';
    expect(roundReportWellFormed(withIssue(block), SPEC)).toBe(false);
  });

  it('is malformed when a FIXED issue omits what-changed (what changed if it was fixed)', () => {
    const block = '- issue: a real defect\n  disposition: fixed\n  reason: it was in scope\n';
    expect(roundReportWellFormed(withIssue(block), SPEC)).toBe(false);
  });

  it('does NOT require what-changed for a dismissed disposition (nothing changed)', () => {
    const block = '- issue: out of scope observation\n  disposition: dismissed — out of scope\n  reason: not this ticket\n';
    expect(roundReportWellFormed(withIssue(block), SPEC)).toBe(true);
  });

  it('is malformed when an issue block appears before any persona record (persona not carried)', () => {
    const orphan =
      '## summary\n\n## findings\n\n- issue: orphaned\n  disposition: fixed\n  reason: r\n  what-changed: c\n\n' +
      '### review-principal\n\n_none_\n### review-security\n\n_none_\n\n## disposition\n\ndone\n';
    expect(roundReportWellFormed(orphan, SPEC)).toBe(false);
  });

  // The bullet glyph is NOT part of the contract (§27.5 minimal-not-rigid): an issue is an issue whether the
  // fixer wrote `-`, `*`, `+`, or `1.`. Recognizing only `-` would let a report that records an issue under any
  // other (valid, common) Markdown bullet hide that issue's missing disposition from the §27.12b backstop.
  it('detects an issue under a `*` bullet so its omitted disposition is still caught (backstop robust to glyph)', () => {
    const block = '* issue: a real defect\n  reason: it was in scope\n  what-changed: fixed it\n'; // no disposition
    expect(roundReportWellFormed(withIssue(block), SPEC)).toBe(false);
  });

  it('detects an issue under a numbered `1.` bullet so its omitted disposition is still caught', () => {
    const block = '1. issue: a real defect\n   reason: it was in scope\n   what-changed: fixed it\n'; // no disposition
    expect(roundReportWellFormed(withIssue(block), SPEC)).toBe(false);
  });

  it('accepts a well-formed issue under a `*` bullet (glyph variation is not malformation)', () => {
    const block = '* issue: a real defect\n  disposition: fixed\n  reason: it was in scope\n  what-changed: fixed it\n';
    expect(roundReportWellFormed(withIssue(block), SPEC)).toBe(true);
  });
});

describe('roundReportWellFormed — disposition membership is exact, never normalized (AC6)', () => {
  const withDisposition = (d: string): string =>
    `## summary\n\n## findings\n\n### review-principal\n\n- issue: x\n  disposition: ${d}\n  reason: r\n  what-changed: c\n\n` +
    `### review-security\n\n_none_\n\n## disposition\n\ndone\n`;

  it('accepts every disposition in the closed set', () => {
    for (const d of DISPOSITIONS) expect(roundReportWellFormed(withDisposition(d), SPEC)).toBe(true);
  });

  it('trims surrounding whitespace on the token but does not otherwise normalize', () => {
    expect(roundReportWellFormed(withDisposition('   fixed   '), SPEC)).toBe(true);
  });

  it('rejects a wrong-case disposition (exact string equality)', () => {
    expect(roundReportWellFormed(withDisposition('Fixed'), SPEC)).toBe(false);
  });

  it('rejects an em-dash mismatch (hyphen instead of the em-dash the set spells)', () => {
    expect(roundReportWellFormed(withDisposition('dismissed - out of scope'), SPEC)).toBe(false);
  });

  it('rejects a disposition outside the closed set', () => {
    expect(roundReportWellFormed(withDisposition('wontfix'), SPEC)).toBe(false);
  });
});

describe('roundReportWellFormed — disposition CORRECTNESS is out of scope (Non-goals)', () => {
  it('completes a report of all `needs a human` exactly as a report of all `fixed`', () => {
    const allNeedsHuman =
      '## summary\n\n## findings\n\n### review-principal\n\n- issue: x\n  disposition: needs a human\n  reason: r\n\n' +
      '### review-security\n\n- issue: y\n  disposition: needs a human\n  reason: r\n\n## disposition\n\ndone\n';
    expect(roundReportWellFormed(allNeedsHuman, SPEC)).toBe(true);
  });
});

describe('roundReportWellFormed — linear-time parse on untrusted content (CWE-1333/CWE-400)', () => {
  it('returns within a small time bound on a report carrying a multi-thousand-character colon-less line', () => {
    // The hosted agent writes the report; the engine runs this predicate synchronously on the Electron main
    // thread on every done-signal poll. A single long colon-less line (a stack trace, an indented code block,
    // wrapped prose) must NOT drive super-linear backtracking that wedges node-pty/IPC for seconds-to-minutes.
    const colonlessLine = `x${' '.repeat(50000)}x`;
    const report =
      `## summary\n\n${colonlessLine}\n\n### review-principal\n\n${REPORT_GRAMMAR.emptyMarker}\n\n` +
      `### review-security\n\n${REPORT_GRAMMAR.emptyMarker}\n`;
    const spec: RoundReportSpec = { sections: ['summary'], roster: ['review-principal', 'review-security'] };
    const start = performance.now();
    roundReportWellFormed(report, spec);
    expect(performance.now() - start).toBeLessThan(300);
  }, 30000);
});

describe('failed-reviewer marker + classifier (§27.5/AC7 — the signal the clean-guard keys on)', () => {
  const SPEC2: RoundReportSpec = { sections: ['summary'], roster: ['review-principal', 'review-security'] };
  const g = REPORT_GRAMMAR;

  // The marker is a single token, single-sourced in the grammar (parallel to emptyMarker/DISPOSITIONS) so
  // the fixer prompt, the fake-agent, this classifier, and the well-formedness predicate cannot drift.
  it('the grammar carries a failed marker distinct from the empty marker', () => {
    expect(typeof g.failedMarker).toBe('string');
    expect(g.failedMarker.length).toBeGreaterThan(0);
    expect(g.failedMarker).not.toBe(g.emptyMarker);
  });

  const withMarkers = (principal: string, security: string): string =>
    `## summary\n\n### review-principal\n\n${principal}\n\n### review-security\n\n${security}\n`;

  it('classifies a report recording a reviewer as failed-to-run via the marker', () => {
    const report = withMarkers(g.failedMarker, g.emptyMarker);
    expect(reportHasFailedReviewer(report)).toBe(true);
    expect(failedReviewers(report)).toEqual(['review-principal']);
  });

  it('a reviewer that RAN and found nothing (empty marker) is NOT a failed reviewer (AC7)', () => {
    const report = withMarkers(g.emptyMarker, g.emptyMarker);
    expect(reportHasFailedReviewer(report)).toBe(false);
    expect(failedReviewers(report)).toEqual([]);
  });

  it('a reviewer that RAN and raised a `needs a human` issue is NOT a failed reviewer (AC7)', () => {
    const raised =
      '- issue: something a human must judge\n  disposition: needs a human\n  reason: escalated to the human';
    const report = withMarkers(raised, g.emptyMarker);
    expect(reportHasFailedReviewer(report)).toBe(false);
    expect(failedReviewers(report)).toEqual([]);
  });

  it('returns every failed persona so the engine can compare a two-report window (AC7)', () => {
    const report = withMarkers(g.failedMarker, g.failedMarker);
    expect(new Set(failedReviewers(report))).toEqual(new Set(['review-principal', 'review-security']));
  });

  it('only counts the marker inside a persona record, never in prose outside one', () => {
    const prose = `## summary\n\n${g.failedMarker}\n\n### review-principal\n\n${g.emptyMarker}\n\n### review-security\n\n${g.emptyMarker}\n`;
    expect(reportHasFailedReviewer(prose)).toBe(false);
  });

  // The addition is behavior-preserving for the existing well-formedness reader (§27.5): a report where a
  // roster persona carries ONLY the failed marker is still well-formed — the persona is accounted for.
  it('roundReportWellFormed still accepts a report whose persona carries only the failed marker (additive)', () => {
    const report = withMarkers(g.failedMarker, g.emptyMarker);
    expect(roundReportWellFormed(report, SPEC2)).toBe(true);
  });
});

describe('the closed disposition set is spec-fixed', () => {
  it('is exactly the §27.5 four-value set', () => {
    expect(DISPOSITIONS).toEqual(['fixed', 'dismissed — out of scope', 'dismissed — invalid', 'needs a human']);
  });
});
