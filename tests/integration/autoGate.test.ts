import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_GATE_DECISION_DEFAULT_MS,
  START_CAPTURE_TIMEOUT_MS,
  createAutoGate,
  type AutoGate,
  type DefResolution,
  type StartRun,
} from '../../src/main/autoGate';
import { stepScopedAdvance, type AppGateDecisionDeps, type ApproveClaim, type ApproveDecider, type GateApproveOutcome } from '../../src/main/appGateDecision';
import {
  composeEngineApprove,
  composeLoopBindingResolve,
  composeObservedResolveDef,
  composeRecordFlowTransition,
  composeStartTransition,
} from '../../src/main/autoGateComposition';
import { createFlowManager } from '../../src/main/flow';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { provideAppLoopView } from '../../src/main/loopViewV2';
import { loopDefIdentity, resolveLoopDefV2, type LoopDefV2, type LoopDefV2Context, type LoopDefV2Tiers } from '../../src/main/loopDefV2';
import { armInterrupt, readAppLoopState, readArmedInterrupt, writeAppLoopState, type AppLoopRunState } from '../../src/main/appLoopState';
import { createRealAppGateCommit } from '../../src/main/appGateCommit';
import { createGitRepoFixture } from '../helpers/gitRepo';
import { createLoopNotifier, type LoopNotifyOpts } from '../../src/main/loopNotifier';
import type { FlowLoopView, FlowStateView } from '../../src/shared/ipc';
import type { ConsolidatorVerdict } from '../../src/shared/consolidatorOutput';
import type { FlowStepDef } from '../../src/main/flow';
import { gateDecisionDecider, gateDecisionKind, parseAutoHaltReasons } from '../../src/shared/audit';
import { createVirtualClock, type VirtualClock } from '../helpers/virtualClock';
import { createAppLoopEngineHarness, CONSOLIDATE_KEY, ROSTER, STEP, TEST_BRANCH, TURN_KEY } from '../helpers/appLoopEngineHarness';
import { roundReportWithDisposition } from '../helpers/roundReports';

// §27.9.1 N9b.4–N9b.6, N9b.9 — Impl-slice 1 of #137: the engine-held gate controller driven at its own
// boundary (the approve operation it invokes, the §25 entries it writes, the view it feeds the strip, panel and
// notifier). The approve operation is the injected domain seam; the view is the real `provideAppLoopView`
// reading a real run-state, and the notifier is the real `createLoopNotifier`.

const LOOP = 'plan-loop';
const TURN = CONSOLIDATE_KEY;
const SHA = 'a'.repeat(40);
const OPERATOR_DEF: DefResolution = { tier: 'operator', identity: { name: LOOP, digest: 'd1' } };
const FIXED = (): Date => new Date('2026-07-17T12:00:00.000Z');

const DEF_YAML = `version: v2
name: ${LOOP}
work:
  recipe: prompts/work.md
  artifact: plan
reviewers: []
consolidator:
  recipe: prompts/consolidate.md
boundaries: []
report:
  sections: [summary]
gate:
  - option: approve
    side_effects: []
  - option: request-changes
    side_effects: []
pickup:
  initial_status: planning
  branch_template: plan-loop/issue-{issue}
`;

function loopSteps(authority: FlowStepDef['gateAuthority'], step = STEP): FlowStepDef[] {
  return [
    { id: step, kind: 'loop', loop: LOOP, loopNamespace: 'app', ...(authority ? { gateAuthority: authority } : {}) },
    { id: 'next', kind: 'manual' },
  ];
}
const startRun = (steps: FlowStepDef[], trust: StartRun['flowSourceTrust'] = 'operator'): StartRun => ({
  definition: { name: 'trusted-flow', steps },
  flowSourceTrust: trust,
});

interface Approval {
  repoDir: string;
  step: string;
  turnKey: string;
  decider: ApproveDecider['kind'];
  claim?: ApproveClaim;
}

interface Rig {
  gate: AutoGate;
  clock: VirtualClock;
  audits: { repoDir: string; cmd: string; exit: number | null }[];
  approvals: Approval[];
  views: FlowLoopView[];
  notify: ReturnType<typeof vi.fn<(o: LoopNotifyOpts) => () => void>>;
  outcome: (o: GateApproveOutcome) => void;
  hold: () => () => void;
  view: (repoDir?: string) => FlowLoopView;
  pushView: (repoKey: string) => void;
  useEngine: (engine: EngineLike) => void;
}

type EngineLike = Parameters<typeof provideAppLoopView>[0];

let appDir: string;
let repoDir: string;
let repoB: string;
let current: StartRun;
let defNow: DefResolution | null;

const tiers = (): LoopDefV2Tiers => ({ operator: null, appBundled: join(appDir, 'loops-v2'), retired: null });

const COMMIT_DEF_YAML = DEF_YAML.replace('  artifact: plan', '  artifact: commits').replace(
  '  - option: approve\n    side_effects: []',
  '  - option: approve\n    side_effects:\n      - kind: commit\n        label: RED',
);

function plantDef(body = DEF_YAML, root = join(appDir, 'loops-v2')): void {
  const dir = join(root, LOOP);
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'work.md'), 'do work\n');
  writeFileSync(join(dir, 'prompts', 'consolidate.md'), 'judge\n');
  writeFileSync(join(dir, `${LOOP}.yaml`), body);
}

const ctxFor = (dir: string): LoopDefV2Context => ({ tiers: tiers(), repoDir: dir });

/** The planted app-bundled def's Start-time resolution, as the controller holds it (plan "Shared definitions"). */
function plantedResolution(dir: string): DefResolution | null {
  const r = resolveLoopDefV2(LOOP, ctxFor(dir));
  return r.ok ? { tier: 'app-bundled', identity: loopDefIdentity(r) } : null;
}

function plantRepoOverride(dir: string): void {
  plantDef(DEF_YAML, join(dir, 'defs'));
  writeFileSync(join(dir, '.agent-loop.yaml'), `loops:\n  ${LOOP}: defs/${LOOP}/${LOOP}.yaml\n`);
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const flowView = (loop: FlowLoopView): FlowStateView => ({
  stepName: STEP,
  runStarted: 'never-started' as const,
  steps: [STEP, 'next'],
  position: 1,
  total: 2,
  status: 'in_progress',
  loop,
});

function makeRig(opts: { auditThrows?: boolean; readsThrow?: () => boolean; runInProgress?: () => boolean } = {}): Rig {
  const clock = createVirtualClock(0);
  const audits: Rig['audits'] = [];
  const approvals: Approval[] = [];
  const views: FlowLoopView[] = [];
  const notify = vi.fn<(o: LoopNotifyOpts) => () => void>(() => () => {});
  const notifier = createLoopNotifier({ isFocused: () => false, onFocusChanged: () => {}, notify, focusWindow: () => {}, reveal: () => {} });
  let nextOutcome: GateApproveOutcome = { kind: 'advanced', effectFailures: [] };
  let held: Promise<void> | null = null;
  let engineLike: EngineLike = { activeRepoDir: () => repoDir, resume: () => {}, liveErrorFor: () => null };
  let gate!: AutoGate;
  const view = (dir = repoDir): FlowLoopView => provideAppLoopView(engineLike, LOOP, { tiers: tiers(), repoDir: dir }, gate.autoGateViewFor);
  const pushView = (repoKey: string): void => {
    const v = view(repoKey);
    views.push(v);
    notifier.observe(repoKey, flowView(v));
  };
  gate = createAutoGate({
    audit: (dir, cmd, exit) => {
      if (opts.auditThrows) throw new Error('audit sink unavailable');
      audits.push({ repoDir: dir, cmd, exit });
    },
    resolveDef: () => {
      if (opts.readsThrow?.()) throw new Error('def read failed');
      return defNow;
    },
    currentRun: () => {
      if (opts.readsThrow?.()) throw new Error('run read failed');
      return current;
    },
    runInProgressAt: () => {
      if (opts.readsThrow?.()) throw new Error('flow-state read failed');
      return opts.runInProgress?.() ?? true;
    },
    onViewChanged: (repoKey) => pushView(repoKey),
    setTimer: (cb, ms) => clock.setTimer(cb, ms),
    clearTimer: (h) => clock.clearTimer(h),
  });
  gate.attachApprove(async (dir, step, turnKey, decider) => {
    const a: Approval = { repoDir: dir, step, turnKey, decider: decider.kind };
    approvals.push(a);
    if (held) await held;
    if (decider.kind === 'engine') a.claim = decider.claimAccept();
    if (a.claim && !a.claim.ok) return 'runEnded' in a.claim ? { kind: 'run-ended' } : { kind: 'abandoned' };
    if (nextOutcome.kind === 'advanced') writeAppLoopState(dir, { loop: LOOP, step, turnKey, status: 'accepted' }, FIXED);
    return nextOutcome;
  });
  return {
    gate,
    clock,
    audits,
    approvals,
    views,
    notify,
    outcome: (o) => (nextOutcome = o),
    hold: () => {
      let release!: () => void;
      held = new Promise<void>((r) => (release = r));
      return () => {
        held = null;
        release();
      };
    },
    view,
    pushView,
    useEngine: (e) => (engineLike = e),
  };
}

const autoHalts = (rig: Rig): string[] => rig.audits.map((a) => a.cmd).filter((c) => gateDecisionKind(c)?.kind === 'auto-halt');
const engineDecided = (rig: Rig): string[] => rig.audits.map((a) => a.cmd).filter((c) => gateDecisionDecider(c) === 'engine');

/** Bind a trusted run at Start and enter its first loop step, as `composeStartTransition` + the preparer do. */
function startTrusted(rig: Rig, steps = loopSteps('auto'), dir = repoDir, capture: string | null = SHA): void {
  current = startRun(steps);
  rig.gate.bindAtStart(dir, current, Date.parse('2026-07-17T12:00:00.000Z'), () => capture);
  rig.gate.commitStart(dir);
  rig.gate.beginLoopRun(dir, steps[0].id);
  rig.gate.observeDefResolution(dir, LOOP, defNow);
}

/** The engine's gate sequence: `gateReaching` before the persist, the persist, then `gateReached`. */
async function reachGate(rig: Rig, verdict: ConsolidatorVerdict, cause: 'verdict' | 'interrupt' = 'verdict', dir = repoDir, step = STEP): Promise<void> {
  rig.gate.gateReaching(dir, step, TURN, verdict, cause);
  writeAppLoopState(dir, { loop: LOOP, step, turnKey: TURN, status: 'complete', round: 1, verdict }, FIXED);
  rig.gate.gateReached(dir, step, TURN);
  await flush();
}

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), 'autogate-app-'));
  repoDir = mkdtempSync(join(tmpdir(), 'autogate-repo-'));
  repoB = mkdtempSync(join(tmpdir(), 'autogate-repoB-'));
  defNow = OPERATOR_DEF;
  plantDef();
});
afterEach(() => {
  for (const d of [appDir, repoDir, repoB]) rmSync(d, { recursive: true, force: true });
});

describe('autoGate — a clean `auto` gate through the real §27 engine (AC1, AC2)', () => {
  const h = createAppLoopEngineHarness();
  beforeEach(() => h.setUp());
  afterEach(() => h.tearDown());

  function wired(persist?: (dir: string, state: AppLoopRunState) => void): { rig: Rig; engine: ReturnType<typeof h.makeEngine> } {
    repoDir = h.repo;
    const rig = makeRig();
    const g = rig.gate;
    const engine = h.makeEngine(persist, undefined, TEST_BRANCH, {
      onViewChanged: () => rig.pushView(h.repo),
      gateReaching: g.gateReaching,
      gateReached: g.gateReached,
      gateNotReached: g.gateNotReached,
      loopRunEvent: g.loopRunEvent,
      interruptArmed: g.interruptArmed,
      consumeInterrupt: g.consumeInterrupt,
    });
    rig.useEngine(engine);
    startTrusted(rig, loopSteps('auto'), h.repo);
    return { rig, engine };
  }

  it('AC1: every view pushed for the transition is not human-needed, the notifier never raises, and the flow advances through the engine approve', async () => {
    const { rig, engine } = wired();
    h.driveToConsolidateInjected(engine);
    h.completeConsolidate(engine, 1, 'verdict: clean\n');
    await flush();
    expect(rig.views.length).toBeGreaterThan(0);
    expect(rig.views.map((v) => v.humanNeeded)).toEqual(rig.views.map(() => false));
    expect(rig.notify).not.toHaveBeenCalled();
    expect(rig.approvals.map((a) => [a.repoDir, a.step, a.decider])).toEqual([[h.repo, STEP, 'engine']]);
  });

  it('AC2: an interrupt armed during the `auto` step\'s own turn halts its clean gate with (c), runs no approve, and is consumed', async () => {
    const { rig, engine } = wired();
    h.driveToConsolidateInjected(engine);
    armInterrupt(h.repo, STEP);
    rig.gate.armInterrupt(h.repo, STEP);
    h.completeConsolidate(engine, 1, 'verdict: clean\n');
    await flush();
    expect(rig.view(h.repo).autoGate?.haltReasons.map((r) => r.reason) ?? []).toContain('c');
    expect(rig.approvals).toEqual([]);
    expect(engineDecided(rig).filter((c) => gateDecisionKind(c)?.kind === 'decision')).toEqual([]);
    expect(readArmedInterrupt(h.repo)).toBeNull();
  });

  // Plan S1 "Capture every approve input" (a): the engine hands the controller the report its artifact check accepted.
  it('(a): a review round whose accepted report records `needs a human` halts the clean gate that follows, with no engine approve', async () => {
    const { rig, engine } = wired();
    h.driveToReviewInjected(engine);
    h.writeReport(roundReportWithDisposition(['summary'], ROSTER, 'needs a human'));
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
    h.completeConsolidate(engine, 1, 'verdict: clean\n');
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ step: STEP, turnKey: CONSOLIDATE_KEY, status: 'complete' });
    expect(rig.approvals).toEqual([]);
    const v = rig.view(h.repo);
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate?.haltGeneric).toBe(true);
    expect(autoHalts(rig)).toHaveLength(1);
  });

  // Plan row "Failed gate persist" (N9b.5(e), §25 truth), through the real engine and controller.
  it('a clean `auto` gate whose `complete` write fails reads human-needed before any timer, raises the notifier, and writes no entry, even after the bound', async () => {
    const { rig, engine } = wired((dir, state) => {
      if (state.status === 'complete') throw new Error('ENOSPC: no space left on device');
      writeAppLoopState(dir, state, FIXED);
    });
    h.driveToConsolidateInjected(engine);
    h.completeConsolidate(engine, 1, 'verdict: clean\n');
    await flush();
    const atOnce = rig.view(h.repo);
    expect(atOnce.humanNeeded).toBe(true);
    expect(atOnce.autoGate).toMatchObject({ deciding: false });
    expect(rig.notify).toHaveBeenCalledTimes(1);
    expect(rig.approvals).toEqual([]);
    expect(engineDecided(rig)).toEqual([]);

    rig.clock.advanceBy(AUTO_GATE_DECISION_DEFAULT_MS);
    await flush();
    expect(engineDecided(rig)).toEqual([]);
    expect(rig.notify).toHaveBeenCalledTimes(1);
  });

  // Plan "The view" (N9b.5(e)) and `loopRunEvent` `accepted` (b), through the engine's route-out Accept; AC1 above is its positive pair.
  it('a turn the operator Accepted out of an error at an `auto` step stops human-needed with (b), notifies once, and writes one `auto-halt` entry', async () => {
    const { rig, engine } = wired();
    h.enterAndInjectWork(engine);
    engine.onStall();
    h.writeArtifact(true);
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ step: STEP, turnKey: TURN_KEY, status: 'complete' });
    expect(rig.approvals).toEqual([]);
    const v = rig.view(h.repo);
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate?.haltGeneric).toBe(true);
    expect(rig.notify).toHaveBeenCalledTimes(1);
    expect(autoHalts(rig)).toHaveLength(1);
  });
});

describe('autoGate — verdict and interrupt halts (AC2)', () => {
  it('a `stop for a human` gate writes one engine `auto-halt` entry naming only the verdict and shows it at the gate', async () => {
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'stop for a human');
    const halts = autoHalts(rig);
    expect(halts).toHaveLength(1);
    expect(parseAutoHaltReasons(halts[0])).toEqual(['stop-for-a-human']);
    expect(gateDecisionDecider(halts[0])).toBe('engine');
    expect(rig.approvals).toEqual([]);
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate?.haltReasons).toEqual([{ reason: 'stop-for-a-human' }]);
  });

  it('`another round` reaching the gate on an interrupt halts with (c) and runs no approve', async () => {
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'another round', 'interrupt');
    expect(rig.view().autoGate?.haltReasons.map((r) => r.reason) ?? []).toContain('c');
    expect(autoHalts(rig)).toHaveLength(1);
    expect(rig.approvals).toEqual([]);
  });

  it('a gate whose persist failed writes no `auto-halt` entry and reads human-needed at once; reaching it later writes exactly one', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.gate.gateReaching(repoDir, STEP, TURN, 'stop for a human', 'verdict');
    writeAppLoopState(repoDir, { loop: LOOP, step: STEP, turnKey: TURN, status: 'error', errorReason: 'persist failed' }, FIXED);
    rig.gate.gateNotReached(repoDir, STEP, TURN);
    await flush();
    expect(autoHalts(rig)).toEqual([]);
    expect(rig.view().humanNeeded).toBe(true);
    expect(rig.approvals).toEqual([]);

    await reachGate(rig, 'stop for a human');
    expect(autoHalts(rig)).toHaveLength(1);
  });
});

describe('autoGate — S1 fail-closed halts from real captures (N9b.6)', () => {
  async function expectGenericHalt(rig: Rig): Promise<void> {
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate?.haltGeneric).toBe(true);
    expect(autoHalts(rig)).toHaveLength(1);
  }

  it('control: a clean `auto` gate with no reason holding is approved by the engine', async () => {
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => [a.step, a.decider])).toEqual([[STEP, 'engine']]);
    expect(autoHalts(rig)).toEqual([]);
  });

  it('(a): a round report recording a `needs a human` disposition halts a clean gate', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.gate.loopRunEvent(repoDir, STEP, 'review-plan', { roundReport: roundReportWithDisposition(['summary'], ['p1'], 'needs a human') });
    await expectGenericHalt(rig);
  });

  it('(a) negative: a round report whose every disposition is settled leaves a clean gate to the engine approve', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.gate.loopRunEvent(repoDir, STEP, 'review-plan', { roundReport: roundReportWithDisposition(['summary'], ['p1'], 'fixed') });
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => [a.step, a.decider])).toEqual([[STEP, 'engine']]);
    expect(autoHalts(rig)).toEqual([]);
  });

  it('(b): an accepted failed turn holds for the rest of the loop run', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.gate.loopRunEvent(repoDir, STEP, 'review-plan', 'accepted');
    await expectGenericHalt(rig);
  });

  it('(b): a loop run that ended in error halts; a Retry clears it and the clean gate is approved', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.gate.loopRunEvent(repoDir, STEP, TURN, 'error');
    await expectGenericHalt(rig);

    const fresh = makeRig();
    startTrusted(fresh);
    fresh.gate.loopRunEvent(repoDir, STEP, TURN, 'error');
    fresh.gate.loopRunEvent(repoDir, STEP, TURN, 'retried');
    await reachGate(fresh, 'clean');
    expect(fresh.approvals.map((a) => a.decider)).toEqual(['engine']);
  });

  it('(g): a repo-tier resolution observed during the loop run halts a clean gate', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.gate.observeDefResolution(repoDir, LOOP, { tier: 'repo', identity: null });
    await expectGenericHalt(rig);
  });

  // Plan row "No intermediate commit is unsafe" (stub-only until S3): an arm naming another step still halts.
  it('(c): an `armed-interrupt.yaml` naming a different step, present when the clean gate is decided, halts and runs no approve', async () => {
    const rig = makeRig();
    startTrusted(rig);
    armInterrupt(repoDir, 'some-other-step');
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    expect(rig.view().autoGate?.haltReasons.map((r) => r.reason) ?? []).toContain('c');
  });

  // Plan row "No intermediate commit is unsafe" (permanent): a repo-tier override seen only by the preparer, through
  // the production preparer composition.
  it('(g): a repo-tier override present only at the preparer\'s resolution halts the loop run\'s clean gate, though it is gone before the gate', async () => {
    const rig = makeRig();
    const preparerResolve = composeLoopBindingResolve(rig.gate, composeObservedResolveDef(rig.gate, ctxFor));
    current = startRun(loopSteps('auto'));
    rig.gate.bindAtStart(repoDir, current, 0, () => SHA);
    rig.gate.commitStart(repoDir);
    plantRepoOverride(repoDir);
    expect(preparerResolve(repoDir, STEP, LOOP)).toMatchObject({ ok: true, tierRoot: repoDir });
    rmSync(join(repoDir, '.agent-loop.yaml'));
    await expectGenericHalt(rig);
  });

  it('control for the preparer leg: an operator-side resolution at the preparer leaves the clean gate to the engine', async () => {
    const rig = makeRig();
    const preparerResolve = composeLoopBindingResolve(rig.gate, composeObservedResolveDef(rig.gate, ctxFor));
    current = startRun(loopSteps('auto'));
    rig.gate.bindAtStart(repoDir, current, 0, () => SHA);
    rig.gate.commitStart(repoDir);
    expect(preparerResolve(repoDir, STEP, LOOP).ok).toBe(true);
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
  });

  it('(h): a Start whose trusted globs commit could not be captured halts a clean gate', async () => {
    const rig = makeRig();
    startTrusted(rig, loopSteps('auto'), repoDir, null);
    await expectGenericHalt(rig);
  });

  it('(i): an earlier engine approve whose effect failed halts the next clean gate', async () => {
    const rig = makeRig();
    current = startRun([
      { id: STEP, kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
      { id: 'second', kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
    ]);
    rig.gate.bindAtStart(repoDir, current, 0, () => SHA);
    rig.gate.commitStart(repoDir);
    rig.gate.beginLoopRun(repoDir, STEP);
    rig.gate.observeDefResolution(repoDir, LOOP, defNow);
    rig.outcome({ kind: 'advanced', effectFailures: ['gh update-issue-body exited 1'] });
    await reachGate(rig, 'clean');
    expect(rig.approvals).toHaveLength(1);

    rig.gate.beginLoopRun(repoDir, 'second');
    rig.gate.observeDefResolution(repoDir, LOOP, defNow);
    await reachGate(rig, 'clean', 'verdict', repoDir, 'second');
    expect(rig.approvals).toHaveLength(1);
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate?.haltGeneric).toBe(true);
  });

  it.each(['green', 'refactor'] as const)('(e) stub: a frozen-check (%s) step halts with (e) until S4\'s check lands', async (completion) => {
    defNow = { ...OPERATOR_DEF, completion };
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    expect(rig.view().autoGate?.haltReasons.map((r) => r.reason)).toEqual(['e']);
    expect(parseAutoHaltReasons(autoHalts(rig)[0] ?? '')).toEqual(['e']);
  });

  it('(e) stub negative: a `red`-completion step is not a frozen-check step, so its clean gate is approved by the engine', async () => {
    defNow = { ...OPERATOR_DEF, completion: 'red' };
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => [a.step, a.decider])).toEqual([[STEP, 'engine']]);
    expect(autoHalts(rig)).toEqual([]);
  });

  // Plan AC8 row "(a) + (c) together": one entry naming every reason that holds; (c)+(e) are S1's letter-keyed pair.
  it('(c) + (e) together on a frozen-check step write exactly one `auto-halt` entry naming both, and two `haltReasons` rows', async () => {
    defNow = { ...OPERATOR_DEF, completion: 'green' };
    const rig = makeRig();
    startTrusted(rig);
    armInterrupt(repoDir, 'some-other-step');
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    const halts = autoHalts(rig);
    expect(halts).toHaveLength(1);
    expect([...(parseAutoHaltReasons(halts[0]) ?? [])].sort()).toEqual(['c', 'e']);
    expect((rig.view().autoGate?.haltReasons.map((r) => r.reason) ?? []).sort()).toEqual(['c', 'e']);
  });
});

describe('autoGate — the decision bound (N9b.5(e))', () => {
  it('a hang after the claim: the bound sets `hung`, the view reads human-needed, and the notifier raises once', async () => {
    const rig = makeRig();
    startTrusted(rig);
    let releaseEffects!: () => void;
    const effects = new Promise<void>((r) => (releaseEffects = r));
    rig.gate.attachApprove(async (dir, step, turnKey, decider) => {
      rig.approvals.push({ repoDir: dir, step, turnKey, decider: decider.kind });
      if (decider.kind === 'engine') decider.claimAccept();
      writeAppLoopState(dir, { loop: LOOP, step, turnKey, status: 'accepted' }, FIXED);
      await effects;
      return { kind: 'advanced', effectFailures: [] };
    });
    await reachGate(rig, 'clean');
    rig.clock.advanceBy(AUTO_GATE_DECISION_DEFAULT_MS - 1);
    expect(rig.view().humanNeeded).toBe(false);
    expect(rig.notify).not.toHaveBeenCalled();
    rig.clock.advanceBy(1);
    const v = rig.view();
    expect(v.autoGate?.hung).toBe(true);
    expect(v.humanNeeded).toBe(true);
    expect(rig.notify).toHaveBeenCalledTimes(1);
    releaseEffects();
    await flush();
    const settled = rig.view();
    expect(settled.autoGate?.hung).toBe(false);
    expect(settled.humanNeeded).toBe(false);
  });

  it('an `advanced` engine approve cancels the bound: past it, no `hung`, no failed effect, no alert and no new entry', async () => {
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
    const entries = rig.audits.length;
    rig.clock.advanceBy(AUTO_GATE_DECISION_DEFAULT_MS);
    await flush();
    const v = rig.view();
    expect(v.humanNeeded).toBe(false);
    expect(v.autoGate?.hung ?? false).toBe(false);
    expect(v.autoGate?.failedEffect).toBeUndefined();
    expect(rig.notify).not.toHaveBeenCalled();
    expect(rig.audits.length).toBe(entries);
  });

  it('a `refused` halt cancels the bound: past it, still one `auto-halt` entry and one alert, no `hung`, no failed effect', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.outcome({ kind: 'refused', reason: 'def changed since Start' });
    await reachGate(rig, 'clean');
    expect(autoHalts(rig)).toHaveLength(1);
    expect(rig.notify).toHaveBeenCalledTimes(1);
    const entries = rig.audits.length;
    rig.clock.advanceBy(AUTO_GATE_DECISION_DEFAULT_MS);
    await flush();
    const v = rig.view();
    expect(v.autoGate?.hung).toBe(false);
    expect(v.autoGate?.failedEffect).toBeUndefined();
    expect(rig.notify).toHaveBeenCalledTimes(1);
    expect(rig.audits.length).toBe(entries);
  });

  it('a (c) halt on a clean gate cancels the bound: past it, still one `auto-halt` entry and one alert, no `hung`', async () => {
    const rig = makeRig();
    startTrusted(rig);
    armInterrupt(repoDir, 'some-other-step');
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    expect(autoHalts(rig)).toHaveLength(1);
    expect(rig.notify).toHaveBeenCalledTimes(1);
    const entries = rig.audits.length;
    rig.clock.advanceBy(AUTO_GATE_DECISION_DEFAULT_MS);
    await flush();
    const v = rig.view();
    expect(v.autoGate?.hung).toBe(false);
    expect(v.autoGate?.failedEffect).toBeUndefined();
    expect(rig.notify).toHaveBeenCalledTimes(1);
    expect(rig.audits.length).toBe(entries);
  });

  it('a `gateReached` or decide setup that throws still reads human-needed at the bound, and not before it', async () => {
    let failReads = false;
    const rig = makeRig({ readsThrow: () => failReads });
    startTrusted(rig);
    rig.gate.gateReaching(repoDir, STEP, TURN, 'clean', 'verdict');
    writeAppLoopState(repoDir, { loop: LOOP, step: STEP, turnKey: TURN, status: 'complete', round: 1, verdict: 'clean' }, FIXED);
    failReads = true;
    try {
      await Promise.resolve(rig.gate.gateReached(repoDir, STEP, TURN));
    } catch {
      /* the throw is the scenario; the bound is what must surface it */
    }
    await flush();
    failReads = false;
    rig.clock.advanceBy(AUTO_GATE_DECISION_DEFAULT_MS - 1);
    expect(rig.view().humanNeeded).toBe(false);
    expect(rig.notify).not.toHaveBeenCalled();
    rig.clock.advanceBy(1);
    expect(rig.view().humanNeeded).toBe(true);
    expect(rig.notify).toHaveBeenCalledTimes(1);
  });

  it('a refused engine approve halts at once, even when its `auto-halt` entry cannot be written', async () => {
    const rig = makeRig({ auditThrows: true });
    startTrusted(rig);
    rig.outcome({ kind: 'refused', reason: 'def changed since Start' });
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
    const v = rig.view();
    expect(v.autoGate?.deciding).toBe(false);
    expect(v.humanNeeded).toBe(true);
    expect(rig.notify).toHaveBeenCalledTimes(1);
  });
});

describe('autoGate — run lifetime and binding (N9b.2, N9b.5(b))', () => {
  it('Terminate ends the engine-held run: a decision pending at that moment claims `run-ended` and writes nothing', async () => {
    const rig = makeRig();
    startTrusted(rig);
    const release = rig.hold();
    await reachGate(rig, 'clean');
    rig.gate.endRun(repoDir);
    release();
    await flush();
    expect(rig.approvals.map((a) => a.claim)).toEqual([{ ok: false, runEnded: true }]);
    expect(engineDecided(rig)).toEqual([]);
    expect(rig.view()).not.toHaveProperty('autoGate');
  });

  it('a held decision whose flow left `in_progress` without an `endRun` is refused at the claim and writes nothing', async () => {
    let inProgress = true;
    const rig = makeRig({ runInProgress: () => inProgress });
    startTrusted(rig);
    const release = rig.hold();
    await reachGate(rig, 'clean');
    inProgress = false;
    release();
    await flush();
    expect(rig.approvals.map((a) => a.claim?.ok)).toEqual([false]);
    expect(engineDecided(rig)).toEqual([]);
  });

  it('bind before entry: resolutions made while the first step is entered inside the Start do not lower it, and its clean gate advances', async () => {
    const rig = makeRig();
    current = startRun(loopSteps('auto'));
    rig.gate.bindAtStart(repoDir, current, 0, () => SHA);
    rig.gate.beginLoopRun(repoDir, STEP);
    rig.gate.observeDefResolution(repoDir, LOOP, defNow);
    rig.gate.commitStart(repoDir);
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
  });

  it('a Start that never began (discarded) leaves no binding behind: a later clean gate is not engine-decided (paired with the control above)', async () => {
    const rig = makeRig();
    current = startRun(loopSteps('auto'));
    rig.gate.bindAtStart(repoDir, current, 0, () => SHA);
    rig.gate.discardStart(repoDir);
    rig.gate.beginLoopRun(repoDir, STEP);
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    expect(rig.view()).not.toHaveProperty('autoGate');
  });

  it('only lowered: a flow source that drops to repo mid-run halts the bound `auto` step', async () => {
    const rig = makeRig();
    startTrusted(rig);
    current = startRun(loopSteps('auto'), 'repo');
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    expect(rig.view().autoGate?.haltGeneric).toBe(true);
  });

  it('never raised: a step bound `human` at Start stays human when the flow later declares it `auto`', async () => {
    const rig = makeRig();
    startTrusted(rig, loopSteps('human'));
    current = startRun(loopSteps('auto'));
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    expect(rig.view().humanNeeded).toBe(true);

    const control = makeRig();
    startTrusted(control, loopSteps('auto'));
    await reachGate(control, 'clean');
    expect(control.approvals).toHaveLength(1);
  });

  it('per-loop-run flags reset at step entry: an error in one loop run does not hold for the next', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.gate.loopRunEvent(repoDir, STEP, TURN, 'error');
    rig.gate.beginLoopRun(repoDir, STEP);
    rig.gate.observeDefResolution(repoDir, LOOP, defNow);
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
  });

  // Plan row "Per-loop-run flags reset at the next step", through the production preparer composition.
  it('a per-loop-run flag raised in one `auto` step does not hold the next step entered through the preparer', async () => {
    const rig = makeRig();
    const preparerResolve = composeLoopBindingResolve(rig.gate, composeObservedResolveDef(rig.gate, ctxFor));
    current = startRun([
      { id: STEP, kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
      { id: 'second', kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
    ]);
    rig.gate.bindAtStart(repoDir, current, 0, () => SHA);
    rig.gate.commitStart(repoDir);
    expect(preparerResolve(repoDir, STEP, LOOP).ok).toBe(true);
    rig.gate.loopRunEvent(repoDir, STEP, TURN, 'error');
    expect(preparerResolve(repoDir, 'second', LOOP).ok).toBe(true);
    await reachGate(rig, 'clean', 'verdict', repoDir, 'second');
    expect(rig.approvals.map((a) => [a.step, a.decider])).toEqual([['second', 'engine']]);
  });

  it('a second loop run entered at the same step keeps the Start-bound authority: its clean gate is engine-approved again', async () => {
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    rig.gate.beginLoopRun(repoDir, STEP);
    rig.gate.observeDefResolution(repoDir, LOOP, defNow);
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine', 'engine']);
  });
});

// AC7 — pinning test: a trusted flow whose step declares `human`, or declares nothing, keeps today's gate exactly.
// It asserts behaviour that does not change, so it is observed green before the controller exists.
describe('autoGate — human and undeclared steps on a trusted flow are unchanged (AC7, pinning)', () => {
  it.each([
    ['declares `human`', 'human' as const],
    ['declares nothing', undefined],
  ])('a step that %s: no approve, no `auto-halt` entry, human-needed, and no `autoGate` on the view', async (_label, authority) => {
    const rig = makeRig();
    startTrusted(rig, loopSteps(authority));
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    expect(autoHalts(rig)).toEqual([]);
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(v).not.toHaveProperty('autoGate');
  });

  // Paired negative of the (b) rows above: an `accepted` or `error` stop at a `human` step writes no `auto-halt` entry.
  it.each([
    ['a human-only run', loopSteps('human'), false],
    ['a run that also binds an `auto` step', [loopSteps('human')[0], { id: 'later', kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' }, { id: 'next', kind: 'manual' }] as FlowStepDef[], true],
  ])('at the `human` step of %s, an accepted turn and an errored loop run write no `auto-halt` entry and show no halt reason', async (_label, steps, isAutoRun) => {
    for (const event of ['accepted', 'error'] as const) {
      const rig = makeRig();
      startTrusted(rig, steps);
      rig.gate.loopRunEvent(repoDir, STEP, TURN, event);
      await reachGate(rig, 'clean');
      expect(rig.approvals).toEqual([]);
      expect(autoHalts(rig)).toEqual([]);
      const v = rig.view();
      if (isAutoRun) {
        expect(v.autoGate?.haltReasons ?? []).toEqual([]);
        expect(v.autoGate?.haltGeneric ?? false).toBe(false);
      } else {
        expect(v).not.toHaveProperty('autoGate');
      }
    }
  });
});

const GATE_RUN: AppLoopRunState = { loop: LOOP, step: STEP, turnKey: TURN, status: 'complete', round: 1, verdict: 'clean' };
const COMMIT_GATE = { gate: [{ option: 'approve', sideEffects: [{ kind: 'commit', args: { label: 'RED' } }] }], outputs: [], work: { recipe: '/r', artifact: 'commits' } } as unknown as LoopDefV2;

/** The approve operation's deps as `approveDepsFor` hands them to both deciders; `over` swaps in a real port. */
function approveDeps(over: Partial<AppGateDecisionDeps> & { advances?: string[] } = {}): AppGateDecisionDeps {
  return {
    readRunState: () => GATE_RUN,
    resolveDef: () => ({ ok: true, def: COMMIT_GATE, tierRoot: '/tmp/tier' }),
    refs: () => ({ pr: null, ticket: null, bootstrap: null }),
    runSideEffect: async () => {},
    runCommitSideEffect: async () => ({ outcome: 'committed', sha: SHA, branch: 'main' }),
    recordBaseline: () => {},
    persistAccept: () => {},
    advanceFlow: (r) => void over.advances?.push(r),
    audit: () => {},
    emitError: () => {},
    emitNotice: () => {},
    onViewChanged: () => {},
    deliverFeedback: () => true,
    deliverRedo: () => true,
    enterPolish: () => {},
    clearPolish: () => {},
    reopenSlice: () => true,
    recordSliceBrief: () => {},
    clearSliceBrief: () => {},
    sourceSliceCount: () => {},
    maybeBeginEpicPromotion: () => ({ kind: 'not-epic' }),
    ...over,
  };
}

/** `approveDeps` reading the run-state the gate persisted and resolving the planted def, as `approveDepsFor` does. */
const plantedApproveDeps = (over: Partial<AppGateDecisionDeps> & { advances?: string[] } = {}): AppGateDecisionDeps =>
  approveDeps({ readRunState: (dir) => readAppLoopState(dir), resolveDef: (dir, name) => resolveLoopDefV2(name, ctxFor(dir)), ...over });

const inProgress = (stepName: string): FlowStateView => ({ stepName, runStarted: 'never-started' as const, steps: [stepName], position: 1, total: 1, status: 'in_progress' });

// The S1 production composition (plan "The slice that introduces each factory"): built in `index.ts`'s order
// against the real controller, so a missing attach or a factory that needs a later one fails here, not at startup.
describe('autoGate — the S1 composition, built in order (#137 S1)', () => {
  const git = { fx: null as ReturnType<typeof createGitRepoFixture> | null };
  afterEach(() => git.fx?.cleanup());

  it('constructs createAutoGate → composeObservedResolveDef, composeRecordFlowTransition → composeEngineApprove → attachApprove → composeStartTransition, composeLoopBindingResolve, and the first clean `auto` gate advances', async () => {
    git.fx = createGitRepoFixture();
    repoDir = git.fx.makeGitRepo('autogate-compose');
    git.fx.writeRepoFile(repoDir, 'README.md', 'compose\n');
    git.fx.commitAll(repoDir, 'init');
    const clock = createVirtualClock(0);
    const advances: string[] = [];
    const gate = createAutoGate({
      audit: () => {},
      resolveDef: (dir) => plantedResolution(dir),
      currentRun: () => current,
      runInProgressAt: () => true,
      onViewChanged: () => {},
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (h) => clock.clearTimer(h),
    });
    const observed = composeObservedResolveDef(gate, (dir) => ({ tiers: tiers(), repoDir: dir }));
    const record = composeRecordFlowTransition({ recordTransition: () => {} }, gate);
    const engineApprove = composeEngineApprove(() => plantedApproveDeps({ advances }), () => 'app');
    gate.attachApprove(engineApprove);
    current = startRun(loopSteps('auto'));
    const flowStart = composeStartTransition({
      autoGate: gate,
      resolveForStart: () => current,
      start: () => inProgress(STEP),
      now: () => Date.parse('2026-07-17T12:00:00.999Z'),
      record,
      captureTimeoutMs: START_CAPTURE_TIMEOUT_MS,
    });
    const preparerResolve = composeLoopBindingResolve(gate, observed);

    flowStart(repoDir);
    expect(preparerResolve(repoDir, STEP, LOOP).ok).toBe(true);
    gate.gateReaching(repoDir, STEP, TURN, 'clean', 'verdict');
    writeAppLoopState(repoDir, GATE_RUN, FIXED);
    gate.gateReached(repoDir, STEP, TURN);
    await flush();
    expect(advances).toEqual([repoDir]);
  });
});

// §27.9.1 N9b.5(e) — the engine approve's advance is scoped to the step it decided, through the same
// `stepScopedAdvance` the human path uses, over the real flow manager.
describe('autoGate — the engine approve\'s advance is step-scoped (#137 S1)', () => {
  const fx = createWorktreeFixture();
  afterEach(() => fx.cleanup());

  it('an engine approve of step N whose flow a manual Advance moved to N+1 mid-effects ends at N+1, entered once', async () => {
    const wt = fx.makeWorktree('engine-step-scoped');
    fx.writeFlowHome(wt, { name: 'scoped', stepIds: [STEP, 'next', 'after'] });
    const entered: string[] = [];
    const flow = createFlowManager({ globalDir: fx.outsideDir('engine-step-scoped-global'), onEnterStep: (step) => void entered.push(step.id) });
    expect(flow.start(wt).stepName).toBe(STEP);
    entered.length = 0;
    plantDef(COMMIT_DEF_YAML);
    defNow = plantedResolution(wt);
    const rig = makeRig();
    rig.gate.attachApprove(
      composeEngineApprove(
        () =>
          plantedApproveDeps({
            runCommitSideEffect: async () => {
              flow.advance(wt);
              return { outcome: 'committed', sha: SHA, branch: 'main' };
            },
            advanceFlow: stepScopedAdvance((repoDir) => flow.state(repoDir).stepName, (repoDir) => void flow.advance(repoDir)),
          }),
        () => 'app',
      ),
    );
    startTrusted(rig, loopSteps('auto'), wt);
    await reachGate(rig, 'clean', 'verdict', wt);
    expect(flow.state(wt).stepName).toBe('next');
    expect(entered).toEqual(['next']);
  });
});

// Plan row "Engine shares the human approve's deps and guard" (S1): the engine approve goes through
// `composeEngineApprove`, so the §B.3 marked-binding refusal and the per-worktree deps factory are the human path's own.
describe('autoGate — the engine approve shares the human approve\'s deps and guard (#137 S1)', () => {
  let git: ReturnType<typeof createGitRepoFixture>;
  beforeEach(() => {
    git = createGitRepoFixture();
    plantDef(COMMIT_DEF_YAML);
  });
  afterEach(() => git.cleanup());

  function recordingEngine(rig: Rig, binding: 'app' | 'legacy'): string[] {
    const effects: string[] = [];
    rig.gate.attachApprove(
      composeEngineApprove(
        () =>
          plantedApproveDeps({
            runSideEffect: async (action) => void effects.push(action),
            runCommitSideEffect: async () => {
              effects.push('commit');
              return { outcome: 'committed', sha: SHA, branch: 'main' };
            },
            persistAccept: () => void effects.push('accept'),
            advanceFlow: () => void effects.push('advance'),
          }),
        () => binding,
      ),
    );
    return effects;
  }

  it('a step whose binding names no surviving engine: the engine approve is refused before any effect, and the gate halts human-needed with `deciding` cleared', async () => {
    defNow = plantedResolution(repoDir);
    const rig = makeRig();
    const effects = recordingEngine(rig, 'legacy');
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(effects).toEqual([]);
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate).toMatchObject({ deciding: false, haltGeneric: true });
  });

  // Plan S1 `checkDef`: the decider is built from the resolution held at Start, so an edit after Start is refused.
  it('a recipe edited after Start: the engine approve is refused before any effect, and the gate halts human-needed', async () => {
    defNow = plantedResolution(repoDir);
    const rig = makeRig();
    const effects = recordingEngine(rig, 'app');
    startTrusted(rig);
    writeFileSync(join(appDir, 'loops-v2', LOOP, 'prompts', 'work.md'), 'do different work\n');
    await reachGate(rig, 'clean');
    expect(effects).toEqual([]);
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate).toMatchObject({ deciding: false, haltGeneric: true });
  });

  it('the same gate on a surviving binding runs the phase commit, the accept and the advance (positive pair)', async () => {
    defNow = plantedResolution(repoDir);
    const rig = makeRig();
    const effects = recordingEngine(rig, 'app');
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect([...effects].sort()).toEqual(['accept', 'advance', 'commit']);
  });

  it('with two bound worktrees, an engine approve in B lands its phase commit in B\'s history and leaves A\'s HEAD unchanged', async () => {
    const a = git.makeGitRepo('autogate-wt-a');
    const b = git.makeGitRepo('autogate-wt-b');
    git.writeRepoFile(a, 'README.md', 'a\n');
    git.writeRepoFile(b, 'README.md', 'b\n');
    const headA = git.commitAll(a, 'init a');
    git.commitAll(b, 'init b');
    git.writeRepoFile(a, 'src/a.ts', 'export const a = 1;\n');
    git.writeRepoFile(b, 'src/b.ts', 'export const b = 1;\n');
    defNow = plantedResolution(b);
    const rig = makeRig();
    rig.gate.attachApprove(composeEngineApprove((repoKey) => plantedApproveDeps({ runCommitSideEffect: createRealAppGateCommit(repoKey) }), () => 'app'));
    startTrusted(rig, loopSteps('auto'), a);
    startTrusted(rig, loopSteps('auto'), b);
    await reachGate(rig, 'clean', 'verdict', b);
    expect(git.git(b, ['rev-list', '--count', 'HEAD'])).toBe('2');
    expect(git.git(b, ['show', '--name-only', '--format=', 'HEAD']).split('\n')).toContain('src/b.ts');
    expect(git.git(a, ['rev-parse', 'HEAD'])).toBe(headA);
  });
});
