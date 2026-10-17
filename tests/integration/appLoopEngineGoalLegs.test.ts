import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { goalNotesRel, goalProgressRel, readAppLoopState, writeAppLoopState } from '../../src/main/appLoopState';
import type { LoopDefV2 } from '../../src/main/loopDefV2';
import { exampleGoalProgress } from '../../src/shared/goalProgress';
import { TURN_DONE_FILENAME } from '../../src/shared/loopTurn';
import { APP_LOOP_DIR_SEGMENTS } from '../../src/main/appLoopPaths';
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

const EARLIER_SESSION = '0badc0de';
/** The progress file of the goal session the engine is running, which a fresh turn draws anew. */
const progressRel = (): string => {
  const session = readAppLoopState(h.repo)?.goalSession;
  if (session === undefined) throw new Error('no goal session is persisted');
  return goalProgressRel(session);
};

const writeProgressAt = (rel: string, text: string): void => {
  const p = join(h.repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

const writeProgress = (text: string): void => {
  const p = join(h.repo, progressRel());
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
    expect(prompt).toContain(progressRel());
    expect(prompt).toContain('"leg": 1');
  });

  it('the prompt holds only a done leg to the completion check, so a checkpoint or a block may write the done-signal without it', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);

    const prompt = promptOf(lastGoal());
    expect(prompt).toMatch(/only `done` is held to the completion check/i);
    expect(prompt).toMatch(/on `checkpoint` or `blocked`, write the done-signal once the progress file is written/i);
  });

  it('the prompt keeps the notes the next leg resumes from apart from the JSON the app reads', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);

    const prompt = promptOf(lastGoal());
    const session = readAppLoopState(h.repo)!.goalSession!;
    expect(prompt).toContain(goalNotesRel(session));
    expect(progressRel()).toMatch(/\.json$/);
  });

  it('hands the session the check that decides whether its progress file ends this leg, and tells it to pass it first', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    writeProgress(exampleGoalProgress(1, 'checkpoint'));
    signalAndDrain(engine);

    const prompt = promptOf(lastGoal());
    expect(prompt).toContain(`check-artifact progress ${progressRel()} 2 legs`);
    expect(prompt).toMatch(/fix .*until it prints `OK`/i);
  });

  it('a progress file that is not JSON falls short and says so', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    writeArtifact(true);
    writeProgress('- Leg: 1\n- Status: done\n');
    engine.onDoneSignal();
    engine.onDoneSignal();

    expect(engine.liveErrorFor(h.repo)?.reason).toMatch(/is not well-formed: it is not valid JSON/);
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
    writeProgressAt(goalProgressRel(EARLIER_SESSION), exampleGoalProgress(4, 'checkpoint'));
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);

    expect(existsSync(join(h.repo, goalProgressRel(EARLIER_SESSION)))).toBe(false);
    expect(progressRel()).not.toBe(goalProgressRel(EARLIER_SESSION));
  });

  it('each fresh work turn keeps its progress in a file of its own', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    const first = progressRel();
    const again = makeEngine();
    enterAndInjectWork(again);

    expect(progressRel()).not.toBe(first);
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

  it.skipIf(process.getuid?.() === 0)('an earlier turn\'s finished progress that could not be cleared is never read as a fresh turn\'s own', () => {
    writeProgressAt(goalProgressRel(EARLIER_SESSION), exampleGoalProgress(1, 'done'));
    writeArtifact(true);
    const area = dirname(join(h.repo, goalProgressRel(EARLIER_SESSION)));
    chmodSync(area, 0o555);
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    try {
      enterAndInjectWork(engine);
      engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
      expect(engine.liveErrorFor(h.repo)?.reason).toMatch(/goal progress file \S+ is missing/);
    } finally {
      chmodSync(area, 0o755);
    }
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
    expect(after[0]).toContain(progressRel());
    expect(after[1]).toMatch(/^\/goal .*leg 2/i);
    expect(promptOf(after[1])).toContain('"leg": 2');
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: TURN_KEY, status: 'working', leg: 2 });
  });

  it('records the checkpoint in the run log and never a completed work turn', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    writeProgress(exampleGoalProgress(1, 'checkpoint'));
    signalAndDrain(engine);

    const logged = h.audit.mock.calls.map((c) => c[1]);
    expect(logged).toContain(`§27 goal turn ${TURN_KEY} leg 1 checkpointed`);
    expect(logged.some((l) => String(l).includes("review passes"))).toBe(false);
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

  it('a relaunch while the def does not resolve keeps the leg reached, and Retry re-runs it once the def resolves', () => {
    const first = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(first);
    writeProgress(exampleGoalProgress(1, 'checkpoint'));
    signalAndDrain(first);

    const good = h.defResult;
    h.defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' };
    const relaunched = makeEngine();
    relaunched.resume(h.repo);
    relaunched.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    h.defResult = good;
    relaunched.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    relaunched.onInjectable();
    relaunched.onInjectable();

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

describe('the leg change itself (§27.3 v2.201)', () => {
  const doneFile = (): string => join(h.repo, ...APP_LOOP_DIR_SEGMENTS, TURN_DONE_FILENAME);

  it('the finished leg done-signal no longer reads as this turn once the next leg is requested', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    writeProgress(exampleGoalProgress(1, 'checkpoint'));
    mkdirSync(dirname(doneFile()), { recursive: true });
    writeFileSync(doneFile(), `${TURN_KEY}\n`);
    engine.onDoneSignal();

    expect(existsSync(doneFile())).toBe(false);
  });

  it('a done-signal that arrives before the next leg\'s prompt goes in is not graded against that leg', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    writeProgress(exampleGoalProgress(1, 'checkpoint'));
    engine.onDoneSignal();
    const before = h.injected.length;
    engine.onDoneSignal();

    expect(h.injected.length).toBe(before);
    engine.onInjectable();
    engine.onInjectable();
    expect(goalCommands().length).toBe(2);
    expect(promptOf(lastGoal())).not.toContain('not this leg');
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'working', leg: 2 });
  });

  it('records the compact it sent between legs, never the clear it did not', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    const before = h.audit.mock.calls.length;
    writeProgress(exampleGoalProgress(1, 'checkpoint'));
    signalAndDrain(engine);

    const boundaries = h.audit.mock.calls.slice(before).map((c) => String(c[1])).filter((l) => l.includes('boundary'));
    expect(boundaries.some((l) => l.includes('/compact'))).toBe(true);
    expect(boundaries.some((l) => l.includes('/clear'))).toBe(false);
  });
});

describe('Accept on a stalled goal session follows what its progress file records (§27.3/§27.12c v2.201)', () => {
  const stalledWith = (progress: string | null): ReturnType<typeof makeEngine> => {
    const gateReaching = vi.fn();
    const engine = makeEngine(undefined, undefined, undefined, { gateReaching });
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    engine.onStall();
    if (progress !== null) writeProgress(progress);
    return engine;
  };

  it('a checkpoint is not accepted as finished: Accept starts the next leg', () => {
    const engine = stalledWith(exampleGoalProgress(1, 'checkpoint'));
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    engine.onInjectable();
    engine.onInjectable();

    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'working', leg: 2 });
    expect(lastGoal()).toMatch(/leg 2/i);
  });

  it('a blocked session reaches the gate as stop for a human, with its question', () => {
    const engine = stalledWith(JSON.stringify({ leg: 1, status: 'blocked', blocked: 'Modal or page?' }));
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');

    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', verdict: 'stop for a human', verdictReason: 'Modal or page?' });
  });

  it('a session still working is refused with the reason, and the turn stays open', () => {
    const engine = stalledWith(exampleGoalProgress(1, 'working'));
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');

    expect(readAppLoopState(h.repo)?.status).toBe('error');
    expect(engine.liveErrorFor(h.repo)?.reason).toContain('still working');
  });

  it('a refused Accept leaves the turn held as stalled, so its own done-signal still finishes it', () => {
    const engine = stalledWith(exampleGoalProgress(1, 'working'));
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');

    expect(engine.liveErrorFor(h.repo)?.stalled).toBe(true);
    writeArtifact(true);
    writeProgress(exampleGoalProgress(1, 'done'));
    engine.onDoneSignal();
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'complete', verdict: 'clean' });
  });

  it('an Accept that arrives after the stalled leg checkpointed by itself leaves the running next leg alone', () => {
    const engine = stalledWith(exampleGoalProgress(1, 'checkpoint'));
    engine.onDoneSignal();
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');

    expect(engine.liveErrorFor(h.repo)).toBeNull();
    expect(readAppLoopState(h.repo)).toMatchObject({ status: 'working', leg: 2 });
  });

  it('a done session with no artifact is still refused', () => {
    const engine = stalledWith(exampleGoalProgress(1, 'done'));
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');

    expect(readAppLoopState(h.repo)?.status).toBe('error');
    expect(engine.liveErrorFor(h.repo)?.reason).toContain('missing');
  });
});

describe('the stall help shows only while the turn can still finish by itself (§27.12 v2.201)', () => {
  const failingComplete = (repoDir: string, state: Parameters<typeof writeAppLoopState>[1]): void => {
    if (state.status === 'complete') throw new Error('ENOSPC: no space left on device');
    writeAppLoopState(repoDir, state);
  };

  it('an Accept whose save fails leaves a stalled turn shown as stalled, and its done-signal still finishes it', () => {
    const engine = makeEngine(failingComplete);
    enterAndInjectWork(engine);
    engine.onStall();
    writeArtifact(true);
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');

    expect(engine.liveErrorFor(h.repo)?.stalled).toBe(true);
  });

  it('an Accept on a blocked session whose save fails no longer shows a stall the done-signal cannot finish', () => {
    const engine = makeEngine(failingComplete);
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    engine.onStall();
    writeProgress(JSON.stringify({ leg: 1, status: 'blocked', blocked: 'Modal or page?' }));
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');

    expect(engine.liveErrorFor(h.repo)?.stalled).toBeUndefined();
  });

  it('a Retry refused because the def no longer resolves does not show the stall help', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    engine.onStall();
    h.defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' };
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry');

    expect(engine.liveErrorFor(h.repo)?.kind).toBe('def-unresolvable');
    expect(engine.liveErrorFor(h.repo)?.stalled).toBeUndefined();
  });

  it('a late done-signal does not resume a turn whose Retry was refused because the def no longer resolves', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef(3));
    enterAndInjectWork(engine);
    engine.onStall();
    h.defResult = { ok: false, reason: 'no §27 def named plan-loop in any tier' };
    engine.routeOut(h.repo, STEP, TURN_KEY, 'retry');
    engine.onDoneSignal();

    expect(engine.liveErrorFor(h.repo)?.kind).toBe('def-unresolvable');
    expect(h.audit.mock.calls.map((c) => String(c[1])).some((l) => l.includes('resumed after a stall'))).toBe(false);
  });
});

describe('a blocked goal session stops its step for a human (§27.3 v2.201)', () => {
  const BLOCKED = JSON.stringify({ leg: 1, status: 'blocked', blocked: 'The plan asks for both a modal and a page.' });

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
