import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRedCheckReport, type RedCheckReport } from '../../src/shared/redCheck';
import { parseLoopCapabilities } from '../../src/shared/loopCapabilities';

// §28.5.2 — this repo's red_check_command, run for real against fixture tests, must print a report the RED gate's
// own parser accepts, classifying each test the way vitest ran it.

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
  it("is this repository's declared red_check_command", () => {
    const caps = parseLoopCapabilities(readFileSync(join(ROOT, 'loop-capabilities.yaml'), 'utf8'));
    expect(caps.ok && caps.value.redCheckCommand).toBe('node scripts/red-check.mjs');
  });

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
