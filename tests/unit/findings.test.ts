import { describe, expect, it } from 'vitest';
import { splitFindings } from '../../src/main/findings';

describe('splitFindings (§15.3 — report → individually-actionable findings)', () => {
  it('makes each top-level list item its own finding', () => {
    const report = '- first thing\n- second thing\n- third thing';
    expect(splitFindings(report)).toEqual(['- first thing', '- second thing', '- third thing']);
  });

  it('keeps an item with its wrapped continuation and sub-bullets together', () => {
    const report = '- principal: a long finding that\n  wraps onto another line\n  - a sub point\n- security: next';
    const findings = splitFindings(report);
    expect(findings.length).toBe(2);
    expect(findings[0]).toContain('principal');
    expect(findings[0]).toContain('wraps onto another line');
    expect(findings[0]).toContain('a sub point');
    expect(findings[1]).toContain('security');
  });

  it('makes each non-list paragraph (blank-line separated) its own finding', () => {
    const report = 'Notable minors\nare worth a look.\n\nCross-lane consensus\nwas reached.';
    expect(splitFindings(report)).toEqual([
      'Notable minors\nare worth a look.',
      'Cross-lane consensus\nwas reached.',
    ]);
  });

  it('splits a report that mixes a paragraph then a list', () => {
    const report = 'Here are the issues:\n\n- one\n- two\n\nThat is all.';
    expect(splitFindings(report)).toEqual(['Here are the issues:', '- one', '- two', 'That is all.']);
  });

  it('supports *, •, and numbered top-level markers', () => {
    expect(splitFindings('* a\n• b\n1. c\n2) d')).toEqual(['* a', '• b', '1. c', '2) d']);
  });

  it('drops empty / whitespace-only segments', () => {
    expect(splitFindings('\n\n   \n')).toEqual([]);
    expect(splitFindings('')).toEqual([]);
  });
});
