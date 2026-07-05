import { describe, expect, it } from 'vitest';
import { githubHttpsHref, numberFromGithubUrl } from '../../src/shared/githubUrl';

describe('githubHttpsHref — the open-external allow-list returns the NORMALIZED url to open', () => {
  it('returns the parsed href for an https github.com url', () => {
    expect(githubHttpsHref('https://github.com/o/r/pull/29')).toBe('https://github.com/o/r/pull/29');
  });
  it('allows an https github subdomain', () => {
    expect(githubHttpsHref('https://www.github.com/o/r/issues/1')).toBe('https://www.github.com/o/r/issues/1');
  });
  it('returns null for http (no TLS), other hosts, and non-web schemes', () => {
    expect(githubHttpsHref('http://github.com/o/r/issues/1')).toBeNull();
    expect(githubHttpsHref('https://evil.com/github.com')).toBeNull();
    expect(githubHttpsHref('javascript:alert(1)')).toBeNull();
    expect(githubHttpsHref('file:///etc/passwd')).toBeNull();
    expect(githubHttpsHref('not a url')).toBeNull();
  });
  // The validator-sink parser differential (CWE-601): the WHATWG URL parser strips an embedded tab so
  // the host passes the allow-list, but a permissive OS handler may split the RAW string on the tab and
  // open a foreign host. Returning the normalized href (tab removed) means the sink opens exactly what
  // was validated, never the raw string.
  it('strips control characters so the opened url cannot differ from the validated host', () => {
    const out = githubHttpsHref('https://evil.com	.github.com/x');
    expect(out).not.toBeNull();
    expect(out).not.toContain('	');
    expect(out).toBe('https://evil.com.github.com/x');
  });
});

// §26.9 — epic-promote / pickup read the issue/PR number back from `gh …` stdout (a URL ending in
// `/<number>`). A drifted/failed output must degrade to null so the ref is simply dropped, never
// crashing the best-effort transition.
describe('numberFromGithubUrl (§26.9 gh create stdout — one parser for every gh caller)', () => {
  it('pulls the trailing number from a gh issue/PR URL', () => {
    expect(numberFromGithubUrl('https://github.com/o/r/issues/502\n')).toBe(502);
    expect(numberFromGithubUrl('  https://github.com/o/r/pull/17  ')).toBe(17);
  });

  it('returns null when the output carries no trailing number', () => {
    expect(numberFromGithubUrl('gh: could not create issue\n')).toBe(null);
    expect(numberFromGithubUrl('https://github.com/o/r/pull/abc')).toBe(null);
    expect(numberFromGithubUrl('')).toBe(null);
  });
});
