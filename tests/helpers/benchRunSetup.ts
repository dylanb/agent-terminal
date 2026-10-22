// The invoking repository, fixture and request the bench runner's tests start from (#180), and the prepared
// working-folder state they read back through the app's own readers.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { BenchFixtureBuilder } from './benchFixtureBuilder';
import type { BenchRoots } from './benchRoots';
import { createFakeBenchGithub, FAKE_BENCH_REPOSITORY } from './benchFakeGithub';
import { createFakeBenchClock, createFakeLauncher } from './benchFakeLauncher';
import { captureFixture } from '../../src/main/benchCapture';
import { createFlowStateStore } from '../../src/main/flowState';
import { createRunResolver } from '../../src/main/runResolver';
import { APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR } from '../../src/main/appLoopPaths';
import type { BenchRunDeps, BenchRunRequest } from '../../src/main/benchRun';

export const V3_FLOW_FILE = join(process.cwd(), 'example', 'flows', 'feature-dev-v3', 'flow.yaml');
export const V3_FLOW = readFileSync(V3_FLOW_FILE, 'utf8');

/** The flow documents every fixture carries: one at the top and one in a subfolder. */
export const FIXTURE_ARTIFACTS: Record<string, string> = {
  'groomed-ticket.md': '# groomed\n\nThe ticket.\n',
  'impl-report/red.slice-1.md': '## red — slice 1\n',
};

/** The flow-state a captured folder holds besides its ticket input. */
export const FIXTURE_INPUTS = { slices: '2' };
export const FIXTURE_REPEAT_COUNTS = { refactor: 1 };

export interface BenchRunSetup {
  /** The invoking repository: `feature-dev-v3` installed in its catalog and active. */
  repo: string;
  commit: string;
  /** A fixture captured from `repo` itself, positioned at `red` with ticket 180. */
  fixture: string;
}

/** An invoking repository and a fixture captured from it with the real capture. */
export async function capturedSetup(b: BenchFixtureBuilder, roots: BenchRoots, prefix = 'bench-run', commitBeforeCapture?: (dir: string) => void): Promise<BenchRunSetup> {
  const { dir } = b.makeRepository(prefix);
  commitBeforeCapture?.(dir);
  const commit = b.git(dir, ['rev-parse', 'HEAD']);
  b.seedFlow(dir, 'feature-dev-v3', V3_FLOW);
  createFlowStateStore(dir).write({ step: 'red', status: 'not_started', inputs: { ticket: '180', ...FIXTURE_INPUTS }, repeatCounts: FIXTURE_REPEAT_COUNTS });
  b.writeArtifacts(dir, FIXTURE_ARTIFACTS);
  const fixture = join(b.outsideDir(`${prefix}-fixtures`), 'fx');
  const captured = await captureFixture({ workingFolder: dir, fixtureDir: fixture, appHome: roots.appHome, github: createFakeBenchGithub() });
  if (!captured.ok) throw new Error(`setup: capture refused (${captured.code})`);
  return { repo: dir, commit, fixture };
}

/** The fields of a hand-written fixture for `commit` with the fake's repository and issue 180. */
export const handFields = (commit: string): Record<string, unknown> => ({
  commit,
  phase_baseline: undefined,
  issue: { repository: FAKE_BENCH_REPOSITORY, number: 180 },
  inputs: FIXTURE_INPUTS,
  repeat_counts: FIXTURE_REPEAT_COUNTS,
});

/** A `bench run` request of span `red`..`refactor`, one run, over fresh fakes, with `over` on top. */
export function runRequest(s: Pick<BenchRunSetup, 'repo' | 'fixture'>, roots: BenchRoots, over: Partial<Omit<BenchRunRequest, 'deps'>> = {}, deps: Partial<BenchRunDeps> = {}): BenchRunRequest {
  return {
    flow: { kind: 'id', id: 'feature-dev-v3' },
    span: { first: 'red', last: 'refactor' },
    fixtureDir: s.fixture,
    runs: '1',
    invokingRepo: s.repo,
    appHome: roots.appHome,
    userConfigRoot: roots.configDir,
    reportRunFolder: () => undefined,
    ...over,
    deps: { github: createFakeBenchGithub(), launcher: createFakeLauncher(), appBundle: roots.bundle, clock: createFakeBenchClock(), ...deps },
  };
}

/** Every file under `dir`, relative path → contents; `{}` when `dir` is absent. */
export function readTree(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p).split(sep).join('/')] = readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

export interface PreparedState {
  head: string;
  onNewBranch: boolean;
  flowState: unknown;
  /** The name of the flow the app's run resolver loads there. */
  flow: string | null;
  /** The source that resolution bound to: the active-flow pointer's catalog entry, or the legacy fallback. */
  binding: unknown;
  artifacts: Record<string, string>;
}

/** What the app reads in a prepared working folder, read through its own readers. */
export function preparedState(b: BenchFixtureBuilder, workingFolder: string, appHome: string): PreparedState {
  const branch = b.git(workingFolder, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const { load, binding } = createRunResolver(appHome)(workingFolder);
  return {
    head: b.git(workingFolder, ['rev-parse', 'HEAD']),
    onNewBranch: branch !== 'main' && branch !== 'HEAD',
    flowState: createFlowStateStore(workingFolder).read(),
    flow: load.ok ? load.definition.name : null,
    binding,
    artifacts: readTree(join(workingFolder, ...APP_LOOP_DIR_SEGMENTS, ARTIFACTS_SUBDIR)),
  };
}

/** The working folders `git worktree list` names for `repo`, the repository's own included. */
export function worktreeCount(b: BenchFixtureBuilder, repo: string): number {
  return b.git(repo, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length;
}
