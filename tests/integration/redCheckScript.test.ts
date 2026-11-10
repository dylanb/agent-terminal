import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRedCheckReport, type RedCheckReport } from '../../src/shared/redCheck';

// §28.5.2

const ROOT = join(__dirname, '..', '..');
const FIXTURES = 'tests/fixtures/red-check';
let report: RedCheckReport;
let exitStatus: number | null;

beforeAll(() => {
  const run = spawnSync(process.execPath, ['scripts/red-check.mjs', '--config', `${FIXTURES}/vitest.config.mjs`], { cwd: ROOT, encoding: 'utf8' });
  exitStatus = run.status;
  const parsed = parseRedCheckReport(run.stdout);
  if (!parsed.ok) throw new Error(`${parsed.reason}\n${run.stdout}\n${run.stderr}`);
  report = parsed.report;
}, 120_000);

const test = (name: string) => report.tests.find((t) => t.name === name);

describe('scripts/red-check.mjs (§28.5.2)', () => {
  it('exits 0 having printed a report, though tests failed', () => {
    expect(exitStatus).toBe(0);
  });

  it('reports an assertion failure at the line of the failing check, with a repo-relative path', () => {
    expect(test('fails at its check')).toMatchObject({ file: `${FIXTURES}/sample.case.ts`, outcome: 'failed-assertion', failures: [{ line: 4 }] });
  });

  it('reports every failing soft assertion in a test', () => {
    expect(test('fails two soft checks')?.failures.map((f) => f.line)).toEqual([8, 9]);
  });

  it('reports a passing test as passed', () => {
    expect(test('passes')?.outcome).toBe('passed');
  });

  it('reports a test that threw a non-assertion error as errored', () => {
    expect(test('throws a TypeError')?.outcome).toBe('errored');
  });

  it('reports a test file that failed to load as errored', () => {
    expect(report.tests.find((t) => t.file === `${FIXTURES}/broken.case.mjs`)?.outcome).toBe('errored');
  });
});

describe('scripts/red-check.mjs when vitest writes no report', () => {
  it('exits non-zero and leaves nothing behind in the temp directory', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'red-check-tmp-'));
    try {
      const run = spawnSync(process.execPath, ['scripts/red-check.mjs', '--config', `${FIXTURES}/absent.config.mjs`], {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: tmp },
      });
      expect(run.status).not.toBe(0);
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('scripts/red-check.mjs with real Chromium', () => {
  let browserReport: RedCheckReport;
  beforeAll(() => {
    const run = spawnSync(process.execPath, ['scripts/red-check.mjs', '--config', `${FIXTURES}/vitest.browser.config.mjs`], { cwd: ROOT, encoding: 'utf8' });
    const parsed = parseRedCheckReport(run.stdout);
    if (!parsed.ok) throw new Error(`${parsed.reason}\n${run.stdout}\n${run.stderr}`);
    browserReport = parsed.report;
  }, 120_000);

  it('maps transformed browser stacks to the authored assertion line', () => {
    expect(browserReport.tests.find(t => t.name === 'fails at its check')).toMatchObject({
      file: `${FIXTURES}/sample.case.ts`, outcome: 'failed-assertion', failures: [{ line: 4 }],
    });
  });

  it('reports both authored soft assertion lines', () => {
    expect(browserReport.tests.find(t => t.name === 'fails two soft checks')).toMatchObject({
      outcome: 'failed-assertion', failures: [{ line: 8 }, { line: 9 }],
    });
  });

  it('keeps browser exceptions distinct from assertions', () => {
    expect(browserReport.tests.find(t => t.name === 'throws a TypeError')?.outcome).toBe('errored');
  });
});
