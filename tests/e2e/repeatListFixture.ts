// The repeat-list fixture flow (`tests/fixtures/repeat-list-flow/`) as an e2e runs it: its loops seeded into an
// isolated operator config, a fake agent scripted for its steps, and the text the agent was given.

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { outputLocation } from '../../src/main/appWorkTurn';
import { resolveLoopDefV2 } from '../../src/main/loopDefV2';
import { flowLocations } from '../helpers/flowFixtures';
import { exampleConfigDir, type HoldSpec, type StepScript } from './fakeTools';

export const REPEAT_LIST_FLOW_DIR = resolve(__dirname, '..', 'fixtures', 'repeat-list-flow');
/** The 3-entry list the `design` step writes for a run that repeats. */
export const STEPS_JSON = join(REPEAT_LIST_FLOW_DIR, 'steps.json');
/** A completed `design` artifact with no list, so its approve sources nothing. */
export const NO_STEPS_JSON = join(REPEAT_LIST_FLOW_DIR, 'no-steps.json');
const LOOPS_DIR = join(REPEAT_LIST_FLOW_DIR, 'loops-v2');
const DESIGN_LOOP = 'repeat-list-design';
const WORK_LOOP = 'repeat-list-work';
/** The steps after `design` that run a work turn, each through the shared work loop. */
const WORK_STEPS = ['build', 'check', 'finish'] as const;

export const repeatListFlowYaml = (): string => readFileSync(join(REPEAT_LIST_FLOW_DIR, 'flow.yaml'), 'utf8');

/** The titles of `STEPS_JSON`'s entries, in order: the fixture's own input, read as the test wrote it. */
export function repeatListTitles(): string[] {
  const doc = JSON.parse(readFileSync(STEPS_JSON, 'utf8')) as { steps: { title: string }[] };
  return doc.steps.map((s) => s.title);
}

/** A copy of the shared example config whose operator loop tier also holds the fixture flow's loops. */
export function seedRepeatListConfig(): string {
  const config = mkdtempSync(join(tmpdir(), 'agent-term-e2e-repeat-list-config-'));
  cpSync(exampleConfigDir, config, { recursive: true });
  const loops = flowLocations.operatorLoops(config);
  for (const loop of readdirSync(LOOPS_DIR)) cpSync(join(LOOPS_DIR, loop), join(loops, loop), { recursive: true });
  return config;
}

/** Where, relative to `repo`, the app puts `loop`'s work artifact on its first iteration: the path its work turn
 *  writes, from the definition the app resolves and the location its completion check reads. */
function outputRel(repo: string, loop: string): string {
  const r = resolveLoopDefV2(loop, { tiers: { operator: LOOPS_DIR, appBundled: LOOPS_DIR, retired: null }, repoDir: repo });
  if (!r.ok) throw new Error(`outputRel(): ${loop} does not resolve in ${repo}: ${r.reason}`);
  const artifact = outputLocation(r.def, r.def.work.artifact, 1);
  if (artifact === null) throw new Error(`outputRel(): ${loop}'s work artifact names no output`);
  return artifact.rel;
}

/** The fake agent's script for the fixture flow in `repo`: `design` writes `designSource`, and every other work
 *  turn writes its marker. Every line the agent reads is logged (`injectedLog`); `holdBuild` holds a `build` turn. */
export function repeatListAgent(repo: string, opts: { designSource: string; holdBuild?: HoldSpec }): Record<string, StepScript> {
  const work = outputRel(repo, WORK_LOOP);
  return {
    design: { artifactRel: outputRel(repo, DESIGN_LOOP), work: 'complete', artifactSource: opts.designSource, logInjected: true },
    ...Object.fromEntries(
      WORK_STEPS.map((id): [string, StepScript] => [
        id,
        { artifactRel: work, work: 'complete', promptedArtifact: true, logInjected: true, ...(id === 'build' && opts.holdBuild !== undefined ? { hold: opts.holdBuild } : {}) },
      ]),
    ),
  };
}

/** Every line the fake agent has read in `repo`, from character `from` on. */
export function injectedLog(repo: string, from = 0): string {
  const file = join(repo, '.agent-terminal', 'injected-log');
  return existsSync(file) ? readFileSync(file, 'utf8').slice(from) : '';
}
