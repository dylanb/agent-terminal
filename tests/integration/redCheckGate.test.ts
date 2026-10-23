import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRed } from '../../src/main/redCheckGate';
import { examplePhaseResult, type IntendedFailure } from '../../src/shared/phaseResult';

let repo: string;
let outside: string;
const ARTIFACTS = ['.agent-terminal', 'loop', 'artifacts'];
const resultPath = (): string => join(repo, ...ARTIFACTS, 'red-result.json');
const reportPath = (): string => join(repo, ...ARTIFACTS, 'red-result.check.json');
const TEST_FILE = 'tests/a.test.ts';

const capabilities = (extra = ''): void =>
  writeFileSync(join(repo, 'loop-capabilities.yaml'), `test_globs: [tests/**]\ntest_command: t\nbuild_command: b\n${extra}`);
const result = (intendedFailures: IntendedFailure[]): void => writeFileSync(resultPath(), examplePhaseResult('failed-assertion', { intendedFailures }));
const report = (failLine: number): void =>
  writeFileSync(
    reportPath(),
    JSON.stringify({ version: 1, tests: [{ file: TEST_FILE, name: 't', outcome: 'failed-assertion', failures: [{ line: failLine, message: 'AssertionError' }] }] }),
  );
const at = (rel: string, seconds: number): void => utimesSync(join(repo, rel), seconds, seconds);
const check = () => checkRed({ repoDir: repo, resultPath: resultPath(), addedTestPaths: [TEST_FILE] });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'red-check-'));
  outside = mkdtempSync(join(tmpdir(), 'red-check-outside-'));
  mkdirSync(join(repo, ...ARTIFACTS), { recursive: true });
  mkdirSync(join(repo, 'tests'));
  writeFileSync(join(repo, TEST_FILE), 'test');
  at(TEST_FILE, 1_000);
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('checkRed — the RED gate holds the repo\'s own report against the declared failures (§28.5.3)', () => {
  it('is unconfigured when the repo declares no red_check_command', () => {
    capabilities();
    expect(check()).toEqual({ kind: 'unconfigured' });
  });

  it('verifies a fresh report whose failures are exactly the declared ones', () => {
    capabilities('red_check_command: node check.mjs\n');
    result([{ file: 'tests/a.test.ts', line: 12 }]);
    report(12);
    at(join(...ARTIFACTS, 'red-result.check.json'), 2_000);
    expect(check()).toEqual({ kind: 'verified', unchecked: [] });
  });

  it('verifies a verification-only result against a fresh report in which its tests all passed, and refuses one in which a test failed', () => {
    capabilities('red_check_command: node check.mjs\n');
    writeFileSync(resultPath(), examplePhaseResult('passed', { verificationOnly: true }));
    const write = (outcome: string): void => {
      writeFileSync(reportPath(), JSON.stringify({ version: 1, tests: [{ file: TEST_FILE, name: 't', outcome, failures: outcome === 'passed' ? [] : [{ line: 4, message: 'AssertionError' }] }] }));
      at(join(...ARTIFACTS, 'red-result.check.json'), 2_000);
    };
    write('passed');
    expect(check()).toEqual({ kind: 'verified', unchecked: [] });
    write('failed-assertion');
    expect(check().kind).toBe('refused');
  });

  it('refuses a test that failed somewhere other than its declared check', () => {
    capabilities('red_check_command: node check.mjs\n');
    result([{ file: 'tests/a.test.ts', line: 12 }]);
    report(9);
    at(join(...ARTIFACTS, 'red-result.check.json'), 2_000);
    const r = check();
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toContain('tests/a.test.ts:9');
  });

  it('refuses a RED result whose intended failures are malformed, naming that problem', () => {
    capabilities('red_check_command: node check.mjs\n');
    writeFileSync(resultPath(), JSON.stringify({ outcome: 'failed-assertion', intendedFailures: 'tests/a.test.ts:12' }));
    report(12);
    at(join(...ARTIFACTS, 'red-result.check.json'), 2_000);
    const r = check();
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toContain('"intendedFailures" is not a list');
  });

  it('refuses when the report is missing, naming where it was expected', () => {
    capabilities('red_check_command: node check.mjs\n');
    result([{ file: 'tests/a.test.ts', line: 12 }]);
    const r = check();
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toContain('red-result.check.json');
  });

  it('refuses a report older than a test file it covers', () => {
    capabilities('red_check_command: node check.mjs\n');
    result([{ file: 'tests/a.test.ts', line: 12 }]);
    report(12);
    at(join(...ARTIFACTS, 'red-result.check.json'), 500);
    const r = check();
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.reason).toContain('older than tests/a.test.ts');
  });

  it('refuses a report that is a link out of the loop artifacts area', () => {
    capabilities('red_check_command: node check.mjs\n');
    result([{ file: 'tests/a.test.ts', line: 12 }]);
    const target = join(outside, 'r.json');
    writeFileSync(target, JSON.stringify({ version: 1, tests: [] }));
    symlinkSync(target, reportPath());
    expect(check().kind).toBe('refused');
  });

  it('refuses when loop-capabilities.yaml is malformed, rather than reading it as unconfigured', () => {
    writeFileSync(join(repo, 'loop-capabilities.yaml'), 'test_globs: 5\n');
    expect(check().kind).toBe('refused');
  });
});
