import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readE2eEnvironment, readPlaywrightReport, readVitestReport } from '../../src/main/testProofResults';
import { FIXTURES } from '../helpers/testProofSuites';

const VITEST_SKIPPED = ['is skipped on purpose', 'is also skipped', 'is still todo', 'is pending'];
const PLAYWRIGHT_SKIPPED = ['skips on linux', 'skips the slow path', 'skips the gate'];
const PLAYWRIGHT_FLAKY = ['retries a paste', 'waits for quiet'];

/** Each expected title appears in exactly one listed name (a listed name may carry its file or describe path). */
function expectNames(listed: readonly string[] | undefined, titles: readonly string[]): void {
  expect.soft(listed ?? []).toHaveLength(titles.length);
  for (const title of titles) expect.soft((listed ?? []).filter((name) => name.endsWith(title)), title).toHaveLength(1);
}

const counts = (read: ReturnType<typeof readVitestReport>) =>
  read.kind === 'read' ? { passed: read.value.passed, failed: read.value.failed, skipped: read.value.skipped, flaky: read.value.flaky } : read;

describe('readVitestReport', () => {
  it('reads a passing report: skipped, todo and pending count as skipped, and every skipped test is named', () => {
    const read = readVitestReport(FIXTURES, 'vitest-pass.json');
    expect.soft(counts(read)).toEqual({ passed: 6, failed: 0, skipped: 4, flaky: 0 });
    expectNames(read.kind === 'read' ? read.value.skippedTests : undefined, VITEST_SKIPPED);
    expect.soft(read.kind === 'read' ? read.value.flakyTests : undefined).toEqual([]);
  });

  it('reads a failing report with its failed count', () => {
    expect(counts(readVitestReport(FIXTURES, 'vitest-fail.json'))).toEqual({ passed: 6, failed: 1, skipped: 4, flaky: 0 });
  });

  it('counts a test file that failed to load as failed, though no assertion in it failed', () => {
    const read = readVitestReport(FIXTURES, 'vitest-file-error.json');
    expect.soft(read.kind).toBe('read');
    expect.soft(read.kind === 'read' ? read.value.passed : undefined).toBe(3);
    expect.soft(read.kind === 'read' ? read.value.failed : 0).toBeGreaterThan(0);
  });

  it.each([
    ['a report with no testResults', 'vitest-missing-results.json'],
    ['a truncated report', 'unparsable.json'],
    ['a missing report file', 'absent-vitest.json'],
  ])('reads %s as unreadable', (_what, file) => {
    expect(readVitestReport(FIXTURES, file).kind).toBe('unreadable');
  });
});

describe('readPlaywrightReport', () => {
  it('reads a passing report: flaky tests count in passed and are named, and every skipped test is named', () => {
    const read = readPlaywrightReport(FIXTURES, 'playwright-pass.json');
    expect.soft(counts(read)).toEqual({ passed: 7, failed: 0, skipped: 3, flaky: 2 });
    expectNames(read.kind === 'read' ? read.value.flakyTests : undefined, PLAYWRIGHT_FLAKY);
    expectNames(read.kind === 'read' ? read.value.skippedTests : undefined, PLAYWRIGHT_SKIPPED);
  });

  it('reads a failing report with its failed count', () => {
    expect(counts(readPlaywrightReport(FIXTURES, 'playwright-fail.json'))).toEqual({ passed: 7, failed: 1, skipped: 3, flaky: 2 });
  });

  it('counts a spec file that failed to load as failed, never as an empty pass', () => {
    const read = readPlaywrightReport(FIXTURES, 'playwright-load-error.json');
    expect.soft(read.kind).toBe('read');
    expect.soft(read.kind === 'read' ? read.value.failed : 0).toBeGreaterThan(0);
  });

  it.each([
    ['a report with no stats', 'playwright-missing-stats.json'],
    ['a truncated report', 'unparsable.json'],
    ['a missing report file', 'absent-report.json'],
  ])('reads %s as unreadable', (_what, file) => {
    expect(readPlaywrightReport(FIXTURES, file).kind).toBe('unreadable');
  });

  describe('with a count that is not a non-negative integer', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'test-proof-results-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it.each([
      ['a negative unexpected count', { unexpected: -1 }],
      ['a fractional expected count', { expected: 4.5 }],
      ['a string flaky count', { flaky: '2' }],
    ])('reads %s as unreadable', (_what, patch) => {
      const report = JSON.parse(readFileSync(join(FIXTURES, 'playwright-pass.json'), 'utf8')) as { stats: Record<string, unknown> };
      writeFileSync(join(dir, 'report.json'), JSON.stringify({ ...report, stats: { ...report.stats, ...patch } }));
      expect(readPlaywrightReport(dir, 'report.json').kind).toBe('unreadable');
    });
  });
});

describe('readE2eEnvironment', () => {
  describe('with a key left out', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'test-proof-environment-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it.each(['node', 'electron', 'image'])('reads an environment file without %s as unreadable', (key) => {
      const environment = JSON.parse(readFileSync(join(FIXTURES, 'environment.json'), 'utf8')) as Record<string, unknown>;
      delete environment[key];
      writeFileSync(join(dir, 'environment.json'), JSON.stringify(environment));
      expect(readE2eEnvironment(dir, 'environment.json').kind).toBe('unreadable');
    });
  });

  it('reads the container Node, the installed Electron and the image ID', () => {
    expect(readE2eEnvironment(FIXTURES, 'environment.json')).toEqual({
      kind: 'read',
      value: { node: 'v22.11.0', electron: '39.2.4', image: 'sha256:5d1f0c7e9a3b2468ace0f13579bdf02468ace13579bdf02468ace13579bdf0' },
    });
  });

  it.each([
    ['an environment file without the image key', 'environment-missing-image.json'],
    ['a truncated environment file', 'unparsable.json'],
    ['a missing environment file', 'absent-environment.json'],
  ])('reads %s as unreadable', (_what, file) => {
    expect(readE2eEnvironment(FIXTURES, file).kind).toBe('unreadable');
  });
});
