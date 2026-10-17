import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { goalProgressRel, readAppLoopState } from '../../src/main/appLoopState';
import { exampleGoalProgress } from '../../src/shared/goalProgress';
import type { LoopDefV2 } from '../../src/main/loopDefV2';
import { REVIEWER_HANDOFF_BEGIN, REVIEWER_HANDOFF_END } from '../../src/main/reviewTurn';
import { createAppLoopEngineHarness, STEP, TURN_KEY } from '../helpers/appLoopEngineHarness';

// §27.3 (v2.200) — a loop whose def runs no engine review rounds goes from its work turn straight to its gate,
// and a goal work turn is submitted as one `/goal` command whose condition names the full work prompt, written
// to a file the engine owns, so the session keeps working, running the loop's reviewers itself, until it holds.

const h = createAppLoopEngineHarness();
const { resolved, makeEngine, fileDef, writeArtifact, enterAndInjectWork } = h;

const GOAL = 'the latest review pass on the plan returned no findings';

const noRoundsDef = (): LoopDefV2 => ({
  ...fileDef(),
  reviewers: [],
  rounds: { kind: 'none' },
  gate: [
    { option: 'approve', sideEffects: [] },
    { option: 'redo', sideEffects: [] },
  ],
});

const goalDef = (): LoopDefV2 => {
  const base = fileDef();
  return { ...base, work: { ...base.work, goal: GOAL }, rounds: { kind: 'none' } };
};

beforeEach(h.setUp);
afterEach(h.tearDown);

describe('a loop with no review rounds goes from its work turn straight to its gate (§27.3 v2.200)', () => {
  it('reaches the gate as clean on the work turn, and injects nothing after the work prompt', () => {
    const gateReaching = vi.fn();
    const engine = makeEngine(undefined, undefined, undefined, { gateReaching });
    h.defResult = resolved(noRoundsDef());
    enterAndInjectWork(engine);
    const injectedAtWork = h.injected.length;
    writeArtifact(true);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();

    expect(h.injected.length).toBe(injectedAtWork);
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: TURN_KEY, status: 'complete', verdict: 'clean' });
    expect(gateReaching).toHaveBeenCalledWith(h.repo, STEP, TURN_KEY, 'clean', 'verdict');
  });

  it('records no review round or consolidator in the run log, because none ran', () => {
    const engine = makeEngine();
    h.defResult = resolved(noRoundsDef());
    enterAndInjectWork(engine);
    writeArtifact(true);
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();

    const logged = h.audit.mock.calls.map((c) => c[1]);
    expect(logged).toContain(`§27 work turn ${TURN_KEY} complete`);
    expect(logged.filter((cmd) => /review round|consolidat/.test(cmd))).toEqual([]);
  });

  it('redo at that gate re-runs the work turn', () => {
    const engine = makeEngine();
    h.defResult = resolved(noRoundsDef());
    enterAndInjectWork(engine);
    writeArtifact(true);
    engine.onDoneSignal();
    const before = h.injected.length;

    expect(engine.redo(h.repo, STEP, TURN_KEY, 'start again')).toBe(true);
    engine.onInjectable();
    engine.onInjectable();
    expect(h.injected.slice(before).some((p) => p.includes('Produce the plan.') && p.includes('start again'))).toBe(true);
  });
});

describe('a goal work turn is one /goal command naming the full work prompt on disk (§27.3 v2.200)', () => {
  const goalCommand = (): string => {
    const cmd = h.injected.find((p) => p.startsWith('/goal '));
    if (cmd === undefined) throw new Error(`no /goal command was injected: ${JSON.stringify(h.injected)}`);
    return cmd;
  };
  const promptFile = (cmd: string): string => {
    const rel = /\.agent-terminal\/\S+\.md/.exec(cmd)?.[0];
    if (rel === undefined) throw new Error(`the /goal command names no prompt file: ${cmd}`);
    return readFileSync(join(h.repo, rel), 'utf8');
  };

  it('submits one line that carries the condition and the done-signal it ends on', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef());
    enterAndInjectWork(engine);

    const cmd = goalCommand();
    expect(cmd).not.toMatch(/[\r\n]/);
    expect(cmd).toContain(GOAL);
    expect(cmd).toContain(`turn-done:${TURN_KEY}`);
    expect(h.injected.some((p) => p.includes('Produce the plan.'))).toBe(false);
  });

  it('writes the full work prompt, with each reviewer as a sub-agent and the hand-off it is given, to the file the command names', () => {
    const engine = makeEngine();
    h.workRefsResult = { ticket: 204, pr: null };
    h.defResult = resolved(goalDef());
    enterAndInjectWork(engine);

    const prompt = promptFile(goalCommand());
    expect(prompt).toContain('Produce the plan.');
    expect(prompt).toContain('subagent_type: plan-loop--review-plan-principal');
    expect(prompt).toContain('subagent_type: plan-loop--review-plan-security');
    const handoff = prompt.slice(prompt.indexOf(REVIEWER_HANDOFF_BEGIN), prompt.indexOf(REVIEWER_HANDOFF_END));
    expect(handoff).toContain('gh issue view 204 --comments');
    expect(handoff).toContain('.agent-terminal/loop/artifacts/plan.md');
    expect(prompt).toContain(`turn-done:${TURN_KEY}`);
  });

  it('refuses the goal turn before submitting it when a reviewer sub-agent is not installed', () => {
    const engine = makeEngine(undefined, undefined, undefined, {
      reviewerAgentProblem: (r) => (r.persona === 'review-plan-security' ? `no sub-agent ${r.loop}--${r.persona} is installed` : null),
    });
    h.defResult = resolved(goalDef());
    enterAndInjectWork(engine);

    expect(h.injected.some((p) => p.startsWith('/goal '))).toBe(false);
    expect(engine.liveErrorFor(h.repo)?.reason).toContain('no sub-agent plan-loop--review-plan-security is installed');
  });

  it('goes to the gate as clean once the session signals done with the artifact in place', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef());
    enterAndInjectWork(engine);
    writeArtifact(true);
    const progress = join(h.repo, goalProgressRel(readAppLoopState(h.repo)!.goalSession!));
    mkdirSync(dirname(progress), { recursive: true });
    writeFileSync(progress, exampleGoalProgress(1, 'done'));
    engine.onDoneSignal();

    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: TURN_KEY, status: 'complete', verdict: 'clean' });
  });
});

describe('a goal session reviews by the same rules as an engine round (§27.3/§27.8 v2.201)', () => {
  const goalPrompt = (): string => {
    const cmd = h.injected.find((p) => p.startsWith('/goal '));
    const rel = cmd === undefined ? undefined : /\.agent-terminal\/\S+\.md/.exec(cmd)?.[0];
    if (rel === undefined) throw new Error(`no /goal prompt file was named: ${JSON.stringify(h.injected)}`);
    return readFileSync(join(h.repo, rel), 'utf8');
  };

  it('a loop that defers polish tells the session to dismiss polish findings, not fix them', () => {
    const engine = makeEngine();
    const def = goalDef();
    h.defResult = resolved({ ...def, report: { ...def.report, polish: 'defer' } });
    enterAndInjectWork(engine);

    expect(goalPrompt()).toContain('`polish — deferred to a later loop`, NEVER `fixed` in this loop');
  });

  it('a loop that fixes polish says nothing about deferring it', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef());
    enterAndInjectWork(engine);

    expect(goalPrompt()).not.toContain('polish — deferred to a later loop');
  });

  it('a finding that only disagrees with a decision the session logged is dismissed', () => {
    const engine = makeEngine();
    h.defResult = resolved(goalDef());
    enterAndInjectWork(engine);

    expect(goalPrompt()).toMatch(/only disagrees with a decision you made and logged[^\n]*\n[^\n]*`dismissed — invalid`/);
  });

  it('a TDD phase session hands its reviewers the impl-slice it covers', () => {
    const engine = makeEngine();
    const base = h.redDef();
    h.defResult = resolved({ ...base, work: { ...base.work, goal: GOAL }, rounds: { kind: 'none' } });
    h.currentSliceResult = 2;
    enterAndInjectWork(engine);

    const prompt = goalPrompt();
    const handoff = prompt.slice(prompt.indexOf(REVIEWER_HANDOFF_BEGIN), prompt.indexOf(REVIEWER_HANDOFF_END));
    expect(handoff).toContain('This round covers impl-slice 2 of the plan only');
  });
});
