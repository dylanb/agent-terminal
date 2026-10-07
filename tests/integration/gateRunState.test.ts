import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appLoopStateFile, loopAreaFile, writeAppLoopState, type AppLoopRunState } from '../../src/main/appLoopState';
import { readGateRunState, writeGateRunState, type GateRunState } from '../../src/main/gateRunState';

// §27.9.1 N9b.5(d), N9b.8 — pinning tests for `gate-run.yaml`, the run's gate state persisted in its own file,
// disjoint from `run-state.yaml` (CLAUDE.md "own file" rule, §19.1/§25 no-gitignore rule).

const FIXED = (): Date => new Date('2026-07-17T12:00:00.000Z');
const RUN: AppLoopRunState = { loop: 'plan-loop', step: 'plan', turnKey: 'consolidate-plan', status: 'complete', round: 1, verdict: 'clean' };
const STATE: GateRunState = {
  run: { flow: 'Auto Flow', startedAt: Date.parse('2026-07-17T12:00:00.000Z') },
  loopRun: { step: 'plan', endedInError: false, acceptedFailure: true, needsAHuman: false, recorded: ['b'] },
  failedEffect: { state: 'set', detail: 'gh update-issue-body exited 1', reported: false },
  relaunchHalt: { step: 'plan', turnKey: 'consolidate-plan', round: 1 },
};

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gate-run-state-'));
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const gateFile = (): string => loopAreaFile(repo, 'gate-run.yaml')!;

describe('gate-run.yaml — its own file, first-run, no .gitignore', () => {
  it('first run: with no `.agent-terminal` root, a write creates the tree and reads back what was written', () => {
    rmSync(join(repo, '.agent-terminal'), { recursive: true, force: true });
    expect(readGateRunState(repo)).toEqual({ kind: 'absent' });
    writeGateRunState(repo, STATE);
    expect(existsSync(gateFile())).toBe(true);
    expect(readGateRunState(repo)).toEqual({ kind: 'ok', state: STATE });
  });

  it('is byte-for-byte untouched by a wholesale run-state write, and vice versa (disjoint files)', () => {
    writeGateRunState(repo, STATE);
    const gateBytes = readFileSync(gateFile(), 'utf8');
    writeAppLoopState(repo, { ...RUN, status: 'error', errorReason: 'boom' }, FIXED);
    expect(readFileSync(gateFile(), 'utf8')).toBe(gateBytes);

    writeAppLoopState(repo, RUN, FIXED);
    const runBytes = readFileSync(appLoopStateFile(repo)!, 'utf8');
    writeGateRunState(repo, { ...STATE, failedEffect: null });
    expect(readFileSync(appLoopStateFile(repo)!, 'utf8')).toBe(runBytes);
  });

  it('never writes a .gitignore (§19.1/§25 no-gitignore rule)', () => {
    writeGateRunState(repo, STATE);
    expect(existsSync(join(repo, '.agent-terminal', 'loop', '.gitignore'))).toBe(false);
    expect(existsSync(join(repo, '.agent-terminal', '.gitignore'))).toBe(false);
    expect(existsSync(join(repo, '.gitignore'))).toBe(false);
  });

  it('leaves a pre-existing .gitignore byte-for-byte unchanged', () => {
    const gitignore = join(repo, '.gitignore');
    const before = '# operator-owned\n.agent-terminal/\n';
    writeFileSync(gitignore, before);
    writeGateRunState(repo, STATE);
    expect(readFileSync(gitignore, 'utf8')).toBe(before);
  });

  it('a relaunch halt with no round reads back as written', () => {
    const noRound: GateRunState = { ...STATE, relaunchHalt: { step: 'plan', turnKey: 'consolidate-plan', round: null } };
    writeGateRunState(repo, noRound);
    expect(readGateRunState(repo)).toEqual({ kind: 'ok', state: noRound });
  });

  it('a file that fails to parse or validate reads as unreadable, never as an absent marker', () => {
    writeGateRunState(repo, STATE);
    writeFileSync(gateFile(), 'schema_version: [unclosed\n');
    expect(readGateRunState(repo)).toEqual({ kind: 'unreadable' });
    writeFileSync(gateFile(), 'schema_version: 1\nflow: x\n');
    expect(readGateRunState(repo)).toEqual({ kind: 'unreadable' });
  });

  it.each([
    ['a wrong schema_version', (t: string) => t.replace(/^schema_version: .*$/m, 'schema_version: 999')],
    ['an unknown recorded letter', (t: string) => t.replace(/- b$/m, '- z')],
    ['a non-boolean flag', (t: string) => t.replace('accepted_failure: true', 'accepted_failure: yes-please')],
    ['an unknown marker state', (t: string) => t.replace('state: set', 'state: maybe')],
    ['a relaunch-halt round that is not a positive integer', (t: string) => t.replace(/^  round: 1$/m, '  round: 0')],
    ['a non-string relaunch-halt turn key', (t: string) => t.replace('turn_key: consolidate-plan', 'turn_key: 7')],
    ['a relaunch halt that is not a record', (t: string) => t.replace(/^relaunch_halt:\n(?:  .*\n)+/m, 'relaunch_halt: plan\n')],
  ])('a file with %s reads as unreadable', (_label, mutate) => {
    writeGateRunState(repo, STATE);
    const text = readFileSync(gateFile(), 'utf8');
    const bad = mutate(text);
    expect(bad).not.toBe(text);
    writeFileSync(gateFile(), bad);
    expect(readGateRunState(repo)).toEqual({ kind: 'unreadable' });
  });
});
