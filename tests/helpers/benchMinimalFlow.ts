// The minimal flow the benchmark's whole-run tests drive (tests/fixtures/bench/), and its loop defs, which
// tests install into a benchmark config root's operator tier — the tier the sandbox app reads them from.

import { cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveLoopDefV2, type LoopDefV2 } from '../../src/main/loopDefV2';
import { userConfigLoopsV2Dir } from '../../src/main/userConfig';
import { FLOW_DEF_FILE } from '../../src/main/flow';
import { BUNDLED_LOOPS_ROOT } from './bundledLoops';

export const BENCH_FIXTURES_DIR = resolve(__dirname, '..', 'fixtures', 'bench');
export const BENCH_MINIMAL_FLOW = 'bench-minimal';
export const BENCH_MINIMAL_FLOW_DIR = join(BENCH_FIXTURES_DIR, 'flows', BENCH_MINIMAL_FLOW);
export const BENCH_MINIMAL_FLOW_FILE = join(BENCH_MINIMAL_FLOW_DIR, FLOW_DEF_FILE);
export const BENCH_MINIMAL_LOOPS_DIR = join(BENCH_FIXTURES_DIR, 'loops-v2', BENCH_MINIMAL_FLOW);
export const BENCH_SCENARIOS_DIR = join(BENCH_FIXTURES_DIR, 'scenarios');

export function installMinimalOperatorTier(configRoot: string): string {
  const loops = userConfigLoopsV2Dir(configRoot);
  if (loops === null) throw new Error(`not an absolute config root: ${configRoot}`);
  const dest = join(loops, BENCH_MINIMAL_FLOW);
  cpSync(BENCH_MINIMAL_LOOPS_DIR, dest, { recursive: true });
  return dest;
}

export function minimalLoopDef(loop: string, configRoot: string, repoDir: string): LoopDefV2 {
  const r = resolveLoopDefV2(loop, {
    tiers: { operator: userConfigLoopsV2Dir(configRoot), appBundled: BUNDLED_LOOPS_ROOT, retired: null },
    repoDir,
    flow: BENCH_MINIMAL_FLOW,
  });
  if (!r.ok) throw new Error(`bench-minimal loop ${loop} did not resolve: ${r.reason}`);
  return r.def;
}

export function scenarioDir(name: string): string {
  return join(BENCH_SCENARIOS_DIR, name);
}
