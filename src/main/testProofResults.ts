import type { SuiteResult } from './testProof';

export type SuiteCounts = Omit<SuiteResult, 'environment'>;

export interface E2eEnvironment {
  node: string;
  electron: string;
  image: string;
}

export type ReportRead<T> = { kind: 'read'; value: T } | { kind: 'unreadable'; reason: string };

const NONE: SuiteCounts = { passed: 0, failed: 0, skipped: 0, flaky: 0, skippedTests: [], flakyTests: [] };

export function readVitestReport(_dir: string, _file: string): ReportRead<SuiteCounts> {
  return { kind: 'read', value: NONE };
}

export function readPlaywrightReport(_dir: string, _file: string): ReportRead<SuiteCounts> {
  return { kind: 'read', value: NONE };
}

export function readE2eEnvironment(_dir: string, _file: string): ReportRead<E2eEnvironment> {
  return { kind: 'read', value: { node: '', electron: '', image: '' } };
}
