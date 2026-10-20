// #180 — `bench run`: the refusals, the `bench-run` label, then N runs one after another, each prepared from the
// fixture, launched and waited for.

import type { BenchGithub } from './benchGithub';
import type { AppLauncher } from './benchLauncher';
import type { BundleLocation } from './bundleLocation';
import type { BenchSpan } from '../shared/benchLaunch';

export interface BenchClock {
  now(): number;
  /** One path segment of `[A-Za-z0-9._-]`, naming one command's runs. */
  stamp(): string;
}

/** The production clock over `now`, the epoch-ms time source the entry supplies. */
export function createBenchClock(now: () => number): BenchClock {
  return { now, stamp: () => '' };
}

export type BenchFlowRef = { kind: 'id'; id: string } | { kind: 'path'; file: string };

export type BenchRunRefusal =
  | 'flow-unloadable'
  | 'span-unknown-step'
  | 'span-out-of-order'
  | 'runs-invalid'
  | 'fixture-unparsable'
  | 'commit-absent'
  | 'issue-other-repository'
  | 'pr-acting-gate'
  | 'label-failed'
  | 'issue-copy-failed'
  | 'stamp-exists'
  | 'restore-escapes';

export interface BenchRunDeps {
  github: BenchGithub;
  launcher: AppLauncher;
  appBundle: BundleLocation;
  clock: BenchClock;
}

export interface BenchRunRequest {
  flow: BenchFlowRef;
  span: BenchSpan;
  fixtureDir: string;
  /** The run count as the operator wrote it. */
  runs: string;
  invokingRepo: string;
  appHome: string;
  userConfigRoot: string;
  deps: BenchRunDeps;
}

export type BenchRunResult = { ok: true; runFolders: string[] } | { ok: false; code: BenchRunRefusal; runFolders: string[] };

export async function runBench(_request: BenchRunRequest): Promise<BenchRunResult> {
  return { ok: true, runFolders: [] };
}
