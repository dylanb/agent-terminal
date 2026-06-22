import { describe, expect, it } from 'vitest';
import { buildReportRegion, splitFindings } from '../../src/main/findings';

describe('splitFindings (§15.3 — report → individually-actionable findings)', () => {
  it('makes each top-level list item its own finding, tracking its line span', () => {
    const report = '- first thing\n- second thing\n- third thing';
    expect(splitFindings(report)).toEqual([
      { text: '- first thing', startLine: 0, endLine: 0 },
      { text: '- second thing', startLine: 1, endLine: 1 },
      { text: '- third thing', startLine: 2, endLine: 2 },
    ]);
  });

  it('keeps an item with its wrapped continuation and sub-bullets together (spanning its rows)', () => {
    const report = '- principal: a long finding that\n  wraps onto another line\n  - a sub point\n- security: next';
    const findings = splitFindings(report);
    expect(findings.length).toBe(2);
    expect(findings[0].text).toContain('principal');
    expect(findings[0].text).toContain('wraps onto another line');
    expect(findings[0].text).toContain('a sub point');
    expect(findings[0]).toMatchObject({ startLine: 0, endLine: 2 });
    expect(findings[1].text).toContain('security');
    expect(findings[1]).toMatchObject({ startLine: 3, endLine: 3 });
  });

  it('makes each non-list paragraph (blank-line separated) its own finding', () => {
    const report = 'Notable minors\nare worth a look.\n\nCross-lane consensus\nwas reached.';
    expect(splitFindings(report)).toEqual([
      { text: 'Notable minors\nare worth a look.', startLine: 0, endLine: 1 },
      { text: 'Cross-lane consensus\nwas reached.', startLine: 3, endLine: 4 },
    ]);
  });

  it('splits a report that mixes a paragraph then a list, with the right line spans', () => {
    const report = 'Here are the issues:\n\n- one\n- two\n\nThat is all.';
    expect(splitFindings(report)).toEqual([
      { text: 'Here are the issues:', startLine: 0, endLine: 0 },
      { text: '- one', startLine: 2, endLine: 2 },
      { text: '- two', startLine: 3, endLine: 3 },
      { text: 'That is all.', startLine: 5, endLine: 5 },
    ]);
  });

  it('supports *, •, and numbered top-level markers', () => {
    expect(splitFindings('* a\n• b\n1. c\n2) d')).toEqual([
      { text: '* a', startLine: 0, endLine: 0 },
      { text: '• b', startLine: 1, endLine: 1 },
      { text: '1. c', startLine: 2, endLine: 2 },
      { text: '2) d', startLine: 3, endLine: 3 },
    ]);
  });

  it('drops empty / whitespace-only segments', () => {
    expect(splitFindings('\n\n   \n')).toEqual([]);
    expect(splitFindings('')).toEqual([]);
  });
});

describe('buildReportRegion (§15.3 / §16.8 — findings carry their own on-screen rows)', () => {
  it('offsets each finding span by the report startRow so a chunk maps to its terminal rows', () => {
    const region = buildReportRegion('- a\n- b\n- c', 'heuristic', 10, 12);
    expect(region.children).toEqual([
      { type: 'finding', source: 'heuristic', text: '- a', startRow: 10, endRow: 10 },
      { type: 'finding', source: 'heuristic', text: '- b', startRow: 11, endRow: 11 },
      { type: 'finding', source: 'heuristic', text: '- c', startRow: 12, endRow: 12 },
    ]);
  });

  it('maps a multi-row paragraph finding to its full row span', () => {
    const region = buildReportRegion('alpha one\nalpha two\n\nbeta one\nbeta two', 'heuristic', 20, 24);
    expect(region.children).toEqual([
      { type: 'finding', source: 'heuristic', text: 'alpha one\nalpha two', startRow: 20, endRow: 21 },
      { type: 'finding', source: 'heuristic', text: 'beta one\nbeta two', startRow: 23, endRow: 24 },
    ]);
  });

  it('emits no children for a single-segment report (it stands alone)', () => {
    expect(buildReportRegion('just one paragraph here', 'heuristic', 5, 5).children).toEqual([]);
  });
});
