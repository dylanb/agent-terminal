import { describe, expect, it } from 'vitest';
import { issueNumberFromUrl } from '../../src/main/gateGithub';

// §26.9 — epic-promote reads the issue number back from `gh issue create` stdout (a URL ending in
// `/<number>`). A drifted/failed output must degrade to null so the sub-issue is simply dropped from
// linked_issues, never crashing the best-effort gate transition.
describe('issueNumberFromUrl (§26.9 gh issue create stdout)', () => {
  it('pulls the trailing issue number from a gh issue URL', () => {
    expect(issueNumberFromUrl('https://github.com/o/r/issues/502\n')).toBe(502);
    expect(issueNumberFromUrl('  https://github.com/o/r/issues/17  ')).toBe(17);
  });

  it('returns null when the output carries no trailing number', () => {
    expect(issueNumberFromUrl('gh: could not create issue\n')).toBe(null);
    expect(issueNumberFromUrl('https://github.com/o/r/pull/abc')).toBe(null);
    expect(issueNumberFromUrl('')).toBe(null);
  });
});
