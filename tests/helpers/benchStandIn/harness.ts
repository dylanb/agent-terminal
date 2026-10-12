// A per-test stand-in: a wrapper executable that points the stand-in at this test's own state directory, so the
// benchmark config can name it as the agent and judge command while the run's allowlisted environment carries
// nothing test-specific.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { shellQuote } from '../../../src/shared/shellQuote';
import {
  STAND_IN_STATE_ENV,
  isWaiting,
  readExits,
  readJudgeCalls,
  readLaunches,
  readPrompts,
  readReads,
  readShell,
  recordedPids,
  releaseGate,
  writeBehaviour,
  type ExitEntry,
  type JudgeEntry,
  type LaunchEntry,
  type PromptEntry,
  type ReadEntry,
  type ShellEntry,
  type StandInBehaviour,
} from './protocol';

const STAND_IN_EXECUTABLE = resolve(__dirname, 'stand-in-claude');

export interface StandIn {
  command: string;
  stateDir: string;
  setBehaviour(behaviour: StandInBehaviour): void;
  launches(): LaunchEntry[];
  agentLaunches(): LaunchEntry[];
  prompts(): PromptEntry[];
  reads(): ReadEntry[];
  shell(): ShellEntry[];
  exits(): ExitEntry[];
  judgeCalls(): JudgeEntry[];
  release(gate: string): void;
  waiting(gate: string): boolean;
  livePids(): number[];
}

const STAND_IN_SCRIPT = resolve(__dirname, 'standIn.ts');

function isRunningStandIn(pid: number): boolean {
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return ps.status === 0 && ps.stdout.includes(STAND_IN_SCRIPT);
}

export function createStandIn(root: string, behaviour: StandInBehaviour = {}): StandIn {
  const dir = join(root, 'stand-in');
  const stateDir = join(dir, 'state');
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeBehaviour(stateDir, behaviour);
  const command = join(binDir, 'claude');
  writeFileSync(command, `#!/usr/bin/env bash\nexport ${STAND_IN_STATE_ENV}=${shellQuote(stateDir)}\nexec ${shellQuote(STAND_IN_EXECUTABLE)} "$@"\n`);
  chmodSync(command, 0o755);
  return {
    command,
    stateDir,
    setBehaviour: (b) => writeBehaviour(stateDir, b),
    launches: () => readLaunches(stateDir),
    agentLaunches: () => readLaunches(stateDir).filter((l) => l.mode === 'agent'),
    prompts: () => readPrompts(stateDir),
    reads: () => readReads(stateDir),
    shell: () => readShell(stateDir),
    exits: () => readExits(stateDir),
    judgeCalls: () => readJudgeCalls(stateDir),
    release: (gate) => releaseGate(stateDir, gate),
    waiting: (gate) => isWaiting(stateDir, gate),
    livePids: () => recordedPids(stateDir).filter(isRunningStandIn),
  };
}
