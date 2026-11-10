import { describe, expect, it } from 'vitest';
import {
  composeRedCheckInstruction,
  parseRedCheckReport,
  redCheckReportRel,
  redCheckVerdict,
  verificationCheckVerdict,
  type RedCheckReport,
} from '../../src/shared/redCheck';

const report = (tests: RedCheckReport['tests']): string => JSON.stringify({ version: 1, tests });
const parsed = (text: string): RedCheckReport => {
  const r = parseRedCheckReport(text);
  if (!r.ok) throw new Error(r.reason);
  return r.report;
};

describe('parseRedCheckReport (§28.5.2)', () => {
  it('accepts a well-formed report', () => {
    const r = parseRedCheckReport(
      report([{ file: 'tests/a.test.ts', name: 'adds', outcome: 'failed-assertion', failures: [{ line: 5, message: 'expected 2 to be 3' }] }]),
    );
    expect(r.ok).toBe(true);
  });

  it.each([
    ['not JSON', 'nope'],
    ['an unknown version', JSON.stringify({ version: 2, tests: [] })],
    ['no tests array', JSON.stringify({ version: 1 })],
    ['an unknown outcome', report([{ file: 'tests/a.test.ts', name: 'x', outcome: 'flaky' as never, failures: [] }])],
    ['a failed-assertion test with no failure location', report([{ file: 'tests/a.test.ts', name: 'x', outcome: 'failed-assertion', failures: [] }])],
    ['a non-positive line', report([{ file: 'tests/a.test.ts', name: 'x', outcome: 'failed-assertion', failures: [{ line: 0, message: 'm' }] }])],
    ['a file carrying a control character', report([{ file: 'tests/a\n.test.ts', name: 'x', outcome: 'passed', failures: [] }])],
  ])('rejects %s', (_label, text) => {
    expect(parseRedCheckReport(text).ok).toBe(false);
  });
});

describe('redCheckVerdict — a RED fails exactly where it says it does (§28.5.3)', () => {
  const added = ['tests/a.test.ts'];
  const failing = (line: number, extra: Partial<RedCheckReport['tests'][number]> = {}) => ({
    file: 'tests/a.test.ts',
    name: `t${line}`,
    outcome: 'failed-assertion' as const,
    failures: [{ line, message: 'AssertionError' }],
    ...extra,
  });

  it('passes when every declared check failed by assertion and nothing else failed', () => {
    const v = redCheckVerdict({ report: parsed(report([failing(12)])), intended: [{ file: 'tests/a.test.ts', line: 12 }], addedTestPaths: added });
    expect(v).toEqual({ ok: true, claim: 'declared-failures', unchecked: [] });
  });

  it('refuses a test that failed before reaching its own check (an undeclared failure location)', () => {
    const v = redCheckVerdict({ report: parsed(report([failing(9)])), intended: [{ file: 'tests/a.test.ts', line: 12 }], addedTestPaths: added });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toContain('tests/a.test.ts:9');
      expect(v.reason).toContain('tests/a.test.ts:12');
    }
  });

  it('refuses a test in an added file that errored rather than failing by assertion', () => {
    const v = redCheckVerdict({
      report: parsed(report([failing(12), { file: 'tests/a.test.ts', name: 'boom', outcome: 'errored', failures: [{ line: 3, message: 'TypeError' }] }])),
      intended: [{ file: 'tests/a.test.ts', line: 12 }],
      addedTestPaths: added,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('boom');
  });

  it('refuses when no intended failure is declared', () => {
    const v = redCheckVerdict({ report: parsed(report([failing(12)])), intended: [], addedTestPaths: added });
    expect(v.ok).toBe(false);
  });

  it('ignores failures in files this turn did not add to', () => {
    const v = redCheckVerdict({
      report: parsed(report([failing(12), failing(7, { file: 'tests/other.test.ts' })])),
      intended: [{ file: 'tests/a.test.ts', line: 12 }],
      addedTestPaths: added,
    });
    expect(v).toEqual({ ok: true, claim: 'declared-failures', unchecked: [] });
  });

  it('accepts several failing checks in one test, each declared (expect.soft)', () => {
    const t = { ...failing(12), failures: [{ line: 12, message: 'a' }, { line: 14, message: 'b' }] };
    const v = redCheckVerdict({
      report: parsed(report([t])),
      intended: [{ file: 'tests/a.test.ts', line: 12 }, { file: 'tests/a.test.ts', line: 14 }],
      addedTestPaths: added,
    });
    expect(v).toEqual({ ok: true, claim: 'declared-failures', unchecked: [] });
  });
});

describe('redCheckVerdict — a declared failure the repo check does not cover (§28.5.3)', () => {
  const spec = 'tests/e2e/a.spec.ts';
  const vitestFailure = { file: 'tests/a.test.ts', name: 't', outcome: 'failed-assertion' as const, failures: [{ line: 12, message: 'AssertionError' }] };

  it('passes a RED whose only declared failures are in a file the report never mentions, naming that file unchecked', () => {
    const v = redCheckVerdict({ report: parsed(report([])), intended: [{ file: spec, line: 7 }], addedTestPaths: [spec] });
    expect(v).toEqual({ ok: true, claim: 'declared-failures', unchecked: [spec] });
  });

  it('still holds the covered files to their declared checks', () => {
    const v = redCheckVerdict({
      report: parsed(report([{ ...vitestFailure, failures: [{ line: 9, message: 'AssertionError' }] }])),
      intended: [{ file: 'tests/a.test.ts', line: 12 }, { file: spec, line: 7 }],
      addedTestPaths: ['tests/a.test.ts', spec],
    });
    expect(v.ok).toBe(false);
  });

  it('passes a mixed RED, naming only the uncovered file unchecked', () => {
    const v = redCheckVerdict({
      report: parsed(report([vitestFailure])),
      intended: [{ file: 'tests/a.test.ts', line: 12 }, { file: spec, line: 7 }],
      addedTestPaths: ['tests/a.test.ts', spec],
    });
    expect(v).toEqual({ ok: true, claim: 'declared-failures', unchecked: [spec] });
  });
});

describe('the red-check writer and reader agree (CLAUDE.md shared semantics)', () => {
  it('places the report beside the result file', () => {
    expect(redCheckReportRel('.agent-terminal/loop/artifacts/red-result.slice-2.md')).toBe(
      '.agent-terminal/loop/artifacts/red-result.slice-2.check.json',
    );
  });

  it('the instruction names the command and the report path', () => {
    const text = composeRedCheckInstruction({ command: 'node scripts/red-check.mjs', reportRel: 'r.check.json', resultRel: 'r.json' }).join('\n');
    expect(text).toContain('node scripts/red-check.mjs');
    expect(text).toContain('r.check.json');
  });
});

describe('verificationCheckVerdict — a verification-only RED passes everywhere it added tests (§28.5.3)', () => {
  const added = ['tests/a.test.ts'];
  const test = (outcome: RedCheckReport['tests'][number]['outcome'], file = 'tests/a.test.ts') => ({
    file,
    name: `t-${outcome}`,
    outcome,
    failures: outcome === 'failed-assertion' || outcome === 'errored' ? [{ line: 4, message: 'boom' }] : [],
  });

  it('passes when every test in the added files passed', () => {
    expect(verificationCheckVerdict({ report: parsed(report([test('passed')])), addedTestPaths: added })).toEqual({ ok: true, claim: 'all-passing', unchecked: [] });
  });

  it.each([['failed-assertion'], ['errored'], ['skipped']] as const)('refuses a test in an added file that %s, naming it', (outcome) => {
    const v = verificationCheckVerdict({ report: parsed(report([test('passed'), test(outcome)])), addedTestPaths: added });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain(`t-${outcome}`);
  });

  it('ignores files this turn did not add to', () => {
    expect(verificationCheckVerdict({ report: parsed(report([test('passed'), test('failed-assertion', 'tests/other.test.ts')])), addedTestPaths: added })).toEqual({
      ok: true,
      claim: 'all-passing',
      unchecked: [],
    });
  });

  it('names an added file the report never mentions as not independently checked', () => {
    expect(verificationCheckVerdict({ report: parsed(report([test('passed')])), addedTestPaths: [...added, 'tests/e2e/a.spec.ts'] })).toEqual({
      ok: true,
      claim: 'all-passing',
      unchecked: ['tests/e2e/a.spec.ts'],
    });
  });
});
