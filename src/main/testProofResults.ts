import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { confinedRealPathResult, resolveJail } from './confinedPath';
import { errMsg, isErrno } from './errno';
import type { SuiteResult } from './testProof';
import { isRecord } from './yamlRecord';

export type SuiteCounts = Omit<SuiteResult, 'environment'>;

export interface E2eEnvironment {
  node: string;
  electron: string;
  image: string;
}

export type ReportRead<T> = { kind: 'read'; value: T } | { kind: 'unreadable'; reason: string };

const unreadable = (reason: string): { kind: 'unreadable'; reason: string } => ({ kind: 'unreadable', reason });

class Malformed extends Error {}

function readJson(dir: string, file: string): ReportRead<unknown> {
  const jail = resolveJail(dirname(dir), basename(dir));
  if (jail === null) return unreadable(`${dir} does not exist`);
  const target = confinedRealPathResult(jail, join(jail, file));
  if (!target.ok) return unreadable(`${file} in ${dir} ${target.cause === 'escapes' ? 'leads outside it' : 'cannot be resolved'}`);
  let text: string;
  try {
    text = readFileSync(target.path, 'utf8');
  } catch (e) {
    return unreadable(isErrno(e, 'ENOENT') ? `${file} is missing from ${dir}` : `${file} in ${dir} could not be read: ${errMsg(e)}`);
  }
  try {
    return { kind: 'read', value: JSON.parse(text) as unknown };
  } catch (e) {
    return unreadable(`${file} in ${dir} is not JSON: ${errMsg(e)}`);
  }
}

function parsed<T>(dir: string, file: string, parse: (raw: unknown) => T): ReportRead<T> {
  const read = readJson(dir, file);
  if (read.kind === 'unreadable') return read;
  try {
    return { kind: 'read', value: parse(read.value) };
  } catch (e) {
    if (e instanceof Malformed) return unreadable(`${file} in ${dir} ${e.message}`);
    throw e;
  }
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Malformed(`has no ${what} object`);
  return value;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Malformed(`has no ${what} list`);
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new Malformed(`has no ${what} string`);
  return value;
}

function count(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Malformed(`has a ${what} count that is not a non-negative integer`);
  }
  return value;
}

const VITEST_SKIPPED = new Set(['skipped', 'pending', 'todo', 'disabled']);

export function readVitestReport(dir: string, file: string): ReportRead<SuiteCounts> {
  return parsed(dir, file, (raw) => {
    const counts: SuiteCounts = { passed: 0, failed: 0, skipped: 0, flaky: 0, skippedTests: [], flakyTests: [] };
    for (const entry of list(record(raw, 'report').testResults, 'testResults')) {
      const testFile = record(entry, 'test file');
      let fileFailed = text(testFile.status, 'test file status') === 'failed';
      for (const assertion of list(testFile.assertionResults, 'assertionResults')) {
        const test = record(assertion, 'test');
        const status = text(test.status, 'test status');
        const name = [...list(test.ancestorTitles, 'ancestorTitles').map((t) => text(t, 'ancestor title')), text(test.title, 'test title')].join(' › ');
        if (status === 'passed') counts.passed++;
        else if (status === 'failed') {
          counts.failed++;
          fileFailed = false;
        } else if (VITEST_SKIPPED.has(status)) {
          counts.skipped++;
          counts.skippedTests.push(name);
        } else throw new Malformed(`has a test with the unknown status ${JSON.stringify(status)}`);
      }
      if (fileFailed) counts.failed++;
    }
    return counts;
  });
}

interface PlaywrightSuite {
  titles: string[];
  value: Record<string, unknown>;
}

export function readPlaywrightReport(dir: string, file: string): ReportRead<SuiteCounts> {
  return parsed(dir, file, (raw) => {
    const report = record(raw, 'report');
    const stats = record(report.stats, 'stats');
    const expected = count(stats.expected, 'expected');
    const flaky = count(stats.flaky, 'flaky');
    const counts: SuiteCounts = {
      passed: expected + flaky,
      failed: count(stats.unexpected, 'unexpected') + (report.errors === undefined ? 0 : list(report.errors, 'errors').length),
      skipped: count(stats.skipped, 'skipped'),
      flaky,
      skippedTests: [],
      flakyTests: [],
    };
    const pending: PlaywrightSuite[] = list(report.suites, 'suites').map((s) => ({ titles: [], value: record(s, 'suite') }));
    for (let suite = pending.shift(); suite !== undefined; suite = pending.shift()) {
      const titles = [...suite.titles, text(suite.value.title, 'suite title')];
      for (const child of suite.value.suites === undefined ? [] : list(suite.value.suites, 'suites')) {
        pending.push({ titles, value: record(child, 'suite') });
      }
      for (const entry of suite.value.specs === undefined ? [] : list(suite.value.specs, 'specs')) {
        const spec = record(entry, 'spec');
        const name = [...titles, text(spec.title, 'spec title')].join(' › ');
        for (const test of list(spec.tests, 'tests')) {
          const status = text(record(test, 'test').status, 'test status');
          if (status === 'flaky') counts.flakyTests.push(name);
          else if (status === 'skipped') counts.skippedTests.push(name);
        }
      }
    }
    return counts;
  });
}

export function readE2eEnvironment(dir: string, file: string): ReportRead<E2eEnvironment> {
  return parsed(dir, file, (raw) => {
    const environment = record(raw, 'environment');
    const filled = (key: keyof E2eEnvironment): string => {
      const value = text(environment[key], key);
      if (value === '') throw new Malformed(`has an empty ${key}`);
      return value;
    };
    return { node: filled('node'), electron: filled('electron'), image: filled('image') };
  });
}

export function readPackageVersion(dir: string, file: string): ReportRead<string> {
  return parsed(dir, file, (raw) => text(record(raw, 'package').version, 'version'));
}
