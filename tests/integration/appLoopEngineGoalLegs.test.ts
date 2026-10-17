import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { goalProgressRel, readAppLoopState } from '../../src/main/appLoopState';
import type { LoopDefV2 } from '../../src/main/loopDefV2';
import { exampleGoalProgress } from '../../src/shared/goalProgress';
import { createAppLoopEngineHarness, flushRedGate, STEP, TURN_KEY } from '../helpers/appLoopEngineHarness';

// §27.3 (v2.201) — a goal session keeps its progress in a file the engine reads at its done-signal. A leg
// that ran its passes checkpoints: the engine compacts the session and starts the next leg's /goal, which
// resumes from that file. A session that cannot go on without the operator is blocked, and its step stops
// for a human. A session that finished goes to the gate as before.

const h = createAppLoopEngineHarness();
const { resolved, makeEngine, fileDef, writeArtifact, enterAndInjectWork } = h;

const GOAL = 'the latest review pass on the plan returned no findings';

const goalDef = (passes?: number): LoopDefV2 => {
  const base = fileDef();
  return { ...base, work: { ...base.work, goal: GOAL, ...(passes !== undefined ? { checkpoint: { passes } } : {}) }, rounds: { kind: 'none' } };
};

const writeProgress = (text: string): void => {
  const p = join(h.repo, goalProgressRel());
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

const goalCommands = (): string[] => h.injected.filter((p) => p.startsWith('/goal '));
const lastGoal = (): string => {
  const all = goalCommands();
  if (all.length === 0) throw new Error(`no /goal command was injected: ${JSON.stringify(h.injected)}`);
  return all[all.length - 1];
};
const promptOf = (cmd: string): string => {
  const rel = /\.agent-terminal\/\S+\.md/.exec(cmd)?.[0];
  if (rel === undefined) throw new Error(`the /goal command names no prompt file: ${cmd}`);
  return readFileSync(join(h.repo, rel), 'utf8');
};

/** Fire the done-signal, then let the chained next leg drain its boundary and inject. */
const signalAndDrain = (engine: ReturnType<typeof makeEngine>): void => {
  engine.onDoneSignal();
  engine.onInjectable();
  engine.onInjectable();
};

beforeEach(h.setUp);
afterEach(h.tearDown);

describe('a goal session keeps a progress file (§27.3 v2.201)', () => {
  it('the prompt tells the session where its progress file is and which leg this is', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);

    const prompt = promptOf(lastGoal());
    expect(prompt).toContain(goalProgressRel());
    expect(prompt).toContain('Leg: 1');
  });

  it('the command ends a leg after the declared passes when the goal does not yet hold', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);

    const cmd = lastGoal();
    expect(cmd).toContain(GOAL);
    expect(cmd).toMatch(/leg 1/i);
    expect(cmd).toMatch(/3 review passes/);
    expect(cmd).not.toMatch(/[\r\n]/);
  });

  it('a fresh work turn starts without the progress an earlier turn left', () => {
    writeProgress(exampleGoalProgress(4, 'checkpoint'));
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);

    expect(existsSync(join(h.repo, goalProgressRel()))).toBe(false);
  });

  it('a done-signal with no progress file does not finish the turn', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef());
    enterAndInjectWork(engine);
    writeArtifact(true);
    engine.onDoneSignal();

    expect(readAppLoopState(h.repo)?.status).not.toBe('complete');
    expect(h.injected.filter((p) => p.startsWith('/goal ')).length).toBe(2);
  });

  it('finishes and goes to the gate as clean when the progress records the goal done', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    writeArtifact(true);
    writeProgress(exampleGoalProgress(1, 'done'));
    engine.onDoneSignal();

    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: TURN_KEY, status: 'complete', verdict: 'clean' });
  });
});

describe('a leg that ran its passes checkpoints and the next leg resumes (§27.3 v2.201)', () => {
  it('compacts the session, then starts leg 2 from the progress file', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    const before = h.injected.length;
    writeProgress(exampleGoalProgress(1, 'checkpoint'));
    signalAndDrain(engine);

    const after = h.injected.slice(before);
    expect(after[0]).toMatch(/^\/compact /);
    expect(after[0]).toContain(goalProgressRel());
    expect(after[1]).toMatch(/^\/goal .*leg 2/i);
    expect(promptOf(after[1])).toContain('Leg: 2');
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: TURN_KEY, status: 'working', leg: 2 });
  });

  it('records the checkpoint in the run log and never a completed work turn', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    writeProgress(exampleGoalProgress(1, 'checkpoint'));
    signalAndDrain(engine);

    const logged = h.audit.mock.calls.map((c) => c[1]);
    expect(logged).toContain(`§27 goal turn ${TURN_KEY} leg 1 checkpointed after 3 review passes`);
    expect(logged).not.toContain(`§27 work turn ${TURN_KEY} complete`);
  });

  it('a later leg that finishes goes to the gate as clean', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    writeProgress(exampleGoalProgress(1, 'checkpoint'));
    signalAndDrain(engine);
    writeArtifact(true);
    writeProgress(exampleGoalProgress(2, 'done'));
    engine.onDoneSignal();

    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', verdict: 'clean' });
  });

  it('progress still on an earlier leg does not end this leg', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    writeProgress(exampleGoalProgress(1, 'checkpoint'));
    signalAndDrain(engine);
    const before = h.injected.length;
    engine.onDoneSignal();

    expect(h.injected.slice(before).some((p) => p.startsWith('/compact '))).toBe(false);
    expect(readAppLoopState(h.repo)?.leg).toBe(2);
  });

  it('a checkpoint from a goal def that declares no legs does not start one', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef());
    enterAndInjectWork(engine);
    const before = h.injected.length;
    writeProgress(exampleGoalProgress(1, 'checkpoint'));
    signalAndDrain(engine);

    expect(h.injected.slice(before).some((p) => p.startsWith('/compact '))).toBe(false);
    expect(readAppLoopState(h.repo)?.leg ?? 1).toBe(1);
  });

  it('a checkpoint does not run the phase gate, which only holds once the work is done', async () => {
    const engine = makeEngine();
    const base = h.redDef();
    h.defResult = resolved({ ...base, work: { ...base.work, goal: GOAL, checkpoint: { passes: 3 } }, rounds: { kind: 'none' } });
    enterAndInjectWork(engine);
    writeProgress(exampleGoalProgress(1, 'checkpoint'));
    signalAndDrain(engine);
    await flushRedGate();
    engine.onInjectable();
    engine.onInjectable();

    expect(lastGoal()).toMatch(/leg 2/i);
  });

  it('Retry in a later leg re-runs that leg', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    writeProgress(exampleGoalProgress(1, 'checkpoint'));
    signalAndDrain(engine);
    engine.onStall();
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    engine.onInjectable();
    engine.onInjectable();

    expect(lastGoal()).toMatch(/leg 2/i);
  });

  it('after a relaunch, Retry re-runs the leg the session had reached', () => {
    const first = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(first);
    writeProgress(exampleGoalProgress(1, 'checkpoint'));
    signalAndDrain(first);

    const relaunched = makeEngine();
    relaunched.resume(h.repo);
    relaunched.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    relaunched.onInjectable();
    relaunched.onInjectable();

    expect(lastGoal()).toMatch(/leg 2/i);
  });
});

describe('a blocked goal session stops its step for a human (§27.3 v2.201)', () => {
  const BLOCKED = 'Leg: 1\nStatus: blocked\n\n## Blocked\nThe plan asks for both a modal and a page.\n';

  it('reaches the gate with the verdict stop for a human and the reason it gave', () => {
    const gateReaching = vi.fn();
    const engine = makeEngine(undefined, undefined, undefined, { gateReaching });
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    writeProgress(BLOCKED);
    engine.onDoneSignal();

    expect(readAppLoopState(h.repo)).toMatchObject({
      status: 'complete',
      verdict: 'stop for a human',
      verdictReason: 'The plan asks for both a modal and a page.',
    });
    expect(gateReaching).toHaveBeenCalledWith(h.repo, STEP, TURN_KEY, 'stop for a human', 'verdict');
  });

  it('records the stop in the run log', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    writeProgress(BLOCKED);
    engine.onDoneSignal();

    expect(h.audit.mock.calls.map((c) => c[1])).toContain(`§27 goal turn ${TURN_KEY} blocked on the operator`);
  });
});

describe('a stalled turn says it is stalled, and nothing restarts it (§27.12 v2.201)', () => {
  it('a turn that went quiet after its prompt is held as stalled, and its own done-signal still finishes it', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    const before = h.injected.length;
    engine.onStall();

    expect(engine.liveErrorFor(h.repo)?.stalled).toBe(true);
    expect(h.injected.length).toBe(before);
    writeArtifact(true);
    writeProgress(exampleGoalProgress(1, 'done'));
    engine.onDoneSignal();
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', verdict: 'clean' });
  });

  it('an error that is not a stall is not held as one', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onDoneSignal();

    expect(engine.liveErrorFor(h.repo)?.kind).toBe('turn-error');
    expect(engine.liveErrorFor(h.repo)?.stalled).toBeUndefined();
  });
});
