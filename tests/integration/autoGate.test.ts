import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUTO_GATE_DECISION_DEFAULT_MS,
  createAutoGate,
  type AutoGate,
  type AutoGateDeps,
  type DefResolution,
  type StartRun,
} from '../../src/main/autoGate';
import { stepScopedAdvance, type AppGateDecisionDeps, type ApproveClaim, type ApproveDecider, type GateApproveOutcome } from '../../src/main/appGateDecision';
import {
  composeEngineApprove,
  composeHumanDecisionRunners,
  composeLoopBindingResolve,
  composeObservedResolveDef,
  composeRecordFlowTransition,
  composeStartTransition,
} from '../../src/main/autoGateComposition';
import { createFlowManager } from '../../src/main/flow';
import type { GateDecisionOption } from '../../src/shared/ipc';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { provideAppLoopView } from '../../src/main/loopViewV2';
import { resolveLoopDefV2, type LoopDefV2, type LoopDefV2Context, type LoopDefV2Tiers } from '../../src/main/loopDefV2';
import { armInterrupt, readAppLoopState, readArmedInterrupt, writeAppLoopState, type AppLoopRunState } from '../../src/main/appLoopState';
import { createRealAppGateCommit } from '../../src/main/appGateCommit';
import { migrateBundledLoopDefOnEntry } from '../../src/main/migrateLoopDef';
import { createGitRepoFixture } from '../helpers/gitRepo';
import { createLoopNotifier, type LoopNotifyOpts } from '../../src/main/loopNotifier';
import type { FlowLoopView, FlowStateView } from '../../src/shared/ipc';
import type { ConsolidatorVerdict } from '../../src/shared/consolidatorOutput';
import type { FlowStepDef } from '../../src/main/flow';
import { gateDecisionDecider, gateDecisionKind, parseAutoHaltReasons } from '../../src/shared/audit';
import type { AutoHaltReason } from '../../src/shared/gateAuthority';
import { createVirtualClock, type VirtualClock } from '../helpers/virtualClock';
import { createAppLoopEngineHarness, CONSOLIDATE_KEY, REVIEW_KEY, ROSTER, STEP, TEST_BRANCH, TURN_KEY } from '../helpers/appLoopEngineHarness';
import { roundReportWithDisposition } from '../helpers/roundReports';
import { makeFakeCompletionPredicates } from '../helpers/fakeCompletionPredicates';
import { examplePhaseResult } from '../../src/shared/phaseResult';
import { exampleRoundReport } from '../../src/shared/roundReport';
import type { LoopCompletionPredicates } from '../../src/main/loopCompletionPredicates';

// §27.9.1 N9b.4–N9b.6, N9b.9 — Impl-slice 1 of #137: the engine-held gate controller driven at its own
// boundary (the approve operation it invokes, the §25 entries it writes, the view it feeds the strip, panel and
// notifier). The approve operation is the injected domain seam; the view is the real `provideAppLoopView`
// reading a real run-state, and the notifier is the real `createLoopNotifier`.

const LOOP = 'plan-loop';
const TURN = CONSOLIDATE_KEY;
const SHA = 'a'.repeat(40);
const OPERATOR_DEF: DefResolution = {};
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
const startRun = (steps: FlowStepDef[]): StartRun => ({
  definition: { name: 'trusted-flow', steps },
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
  errors: { repoDir: string; reason: string }[];
  approvals: Approval[];
  views: FlowLoopView[];
  notify: ReturnType<typeof vi.fn<(o: LoopNotifyOpts) => () => void>>;
  outcome: (o: GateApproveOutcome | 'throw' | 'reject') => void;
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
  return r.ok ? {} : null;
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
  const errors: Rig['errors'] = [];
  const approvals: Approval[] = [];
  const views: FlowLoopView[] = [];
  const notify = vi.fn<(o: LoopNotifyOpts) => () => void>(() => () => {});
  const notifier = createLoopNotifier({ isFocused: () => false, onFocusChanged: () => {}, notify, focusWindow: () => {}, reveal: () => {} });
  let nextOutcome: GateApproveOutcome | 'throw' | 'reject' = { kind: 'advanced', effectFailures: [] };
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
    emitError: (dir: string, reason: string) => void errors.push({ repoDir: dir, reason }),
    setTimer: (cb, ms) => clock.setTimer(cb, ms),
    clearTimer: (h) => clock.clearTimer(h),
  } as AutoGateDeps);
  gate.attachApprove((dir, step, turnKey, decider) => {
    const a: Approval = { repoDir: dir, step, turnKey, decider: decider.kind };
    approvals.push(a);
    if (nextOutcome === 'throw') throw new Error('approve threw before settling');
    const run = async (): Promise<GateApproveOutcome> => {
      if (held) await held;
      const outcome = nextOutcome;
      if (outcome === 'throw' || outcome === 'reject') throw new Error('approve rejected after the accept');
      if (decider.kind === 'engine') a.claim = decider.claimAccept();
      if (a.claim && !a.claim.ok) {
        if ('runEnded' in a.claim) return { kind: 'run-ended' };
        if ('abandoned' in a.claim) return { kind: 'abandoned' };
        return { kind: 'refused-late', reasons: a.claim.reasons };
      }
      if (outcome.kind === 'advanced') writeAppLoopState(dir, { loop: LOOP, step, turnKey, status: 'accepted' }, FIXED);
      return outcome;
    };
    return run();
  });
  return {
    gate,
    clock,
    audits,
    errors,
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

/** The gate shows `letter` as its own labelled row, not folded into the generic one. */
function expectLetterShown(v: FlowLoopView, letter: AutoHaltReason): void {
  expect(v.autoGate?.haltReasons.map((r) => r.reason) ?? []).toContain(letter);
  expect(v.autoGate?.haltGeneric ?? false).toBe(false);
}

/** Bind a trusted run at Start and enter its first loop step, as `composeStartTransition` + the preparer do. */
function startTrusted(rig: Rig, steps = loopSteps('auto'), dir = repoDir): void {
  current = startRun(steps);
  rig.gate.bindAtStart(dir, current, Date.parse('2026-07-17T12:00:00.000Z'));
  rig.gate.commitStart(dir);
  rig.gate.beginLoopRun(dir, steps[0].id);
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

  function wired(persist?: (dir: string, state: AppLoopRunState) => void, predicates?: LoopCompletionPredicates): { rig: Rig; engine: ReturnType<typeof h.makeEngine> } {
    repoDir = h.repo;
    const rig = makeRig();
    const g = rig.gate;
    const engine = h.makeEngine(persist, predicates, TEST_BRANCH, {
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
    expect(rig.notify).toHaveBeenCalledTimes(1);
    expectLetterShown(v, 'a');
    expect(autoHalts(rig)).toHaveLength(1);
    expect(parseAutoHaltReasons(autoHalts(rig)[0])).toContain('a');
  });

  // §27.9.1 N9b.6 — a reason whose evaluation cannot complete holds: a report the engine cannot re-read is (a).
  it('(a): a round report that passed its artifact check but cannot be re-read halts the clean gate that follows, with no engine approve', async () => {
    const { rig, engine } = wired();
    h.driveToReviewInjected(engine);
    h.writeReport(roundReportWithDisposition(['summary'], ROSTER, 'fixed'));
    const read = h.readArtifact.getMockImplementation()!;
    let reportReads = 0;
    h.readArtifact.mockImplementation((p) => (p.includes('/reports/') && ++reportReads > 1 ? null : read(p)));
    engine.onDoneSignal();
    engine.onInjectable();
    engine.onInjectable();
    h.completeConsolidate(engine, 1, 'verdict: clean\n');
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ step: STEP, turnKey: CONSOLIDATE_KEY, status: 'complete' });
    expect(rig.approvals).toEqual([]);
    expect(rig.view(h.repo).humanNeeded).toBe(true);
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
    expectLetterShown(v, 'b');
    expect(rig.notify).toHaveBeenCalledTimes(1);
    expect(autoHalts(rig)).toHaveLength(1);
    expect(parseAutoHaltReasons(autoHalts(rig)[0])).toContain('b');
  });

  // AC4 (#137 S2): the error stop itself shows and records (b), and the Accept out of it adds no second entry.
  function expectOneBStop(rig: Rig): void {
    const v = rig.view(h.repo);
    expect(v.humanNeeded).toBe(true);
    expectLetterShown(v, 'b');
    expect(rig.notify).toHaveBeenCalledTimes(1);
    const halts = autoHalts(rig);
    expect(halts).toHaveLength(1);
    expect(parseAutoHaltReasons(halts[0])).toContain('b');
    expect(gateDecisionDecider(halts[0])).toBe('engine');
    expect(rig.approvals).toEqual([]);
  }

  it('AC4: a work turn that errors at an `auto` step shows (b) at the error stop, raises the notifier once, and writes one engine `auto-halt` entry', async () => {
    const { rig, engine } = wired();
    h.enterAndInjectWork(engine);
    engine.onStall();
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ step: STEP, turnKey: TURN_KEY, status: 'error' });
    expectOneBStop(rig);
  });

  it('AC4: a review round accepted out of its error at an `auto` step stops with (b): one raise and exactly one engine `auto-halt` entry', async () => {
    const { rig, engine } = wired();
    h.driveToReviewInjected(engine);
    h.writeReport(exampleRoundReport({ sections: ['summary'], roster: [ROSTER[0]] }));
    engine.onDoneSignal();
    engine.onDoneSignal();
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'error' });
    engine.routeOut(h.repo, STEP, REVIEW_KEY, 'accept');
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: REVIEW_KEY, status: 'complete' });
    expectOneBStop(rig);
  });

  it('AC4: a consolidate turn accepted out of its error at an `auto` step stops with (b): one raise and exactly one engine `auto-halt` entry', async () => {
    const { rig, engine } = wired();
    h.driveToConsolidateInjected(engine);
    h.completeConsolidate(engine, 1, 'garbage, no verdict\n');
    h.completeConsolidate(engine, 1, 'garbage, no verdict\n');
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'error' });
    engine.routeOut(h.repo, STEP, CONSOLIDATE_KEY, 'accept');
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: CONSOLIDATE_KEY, status: 'complete' });
    expectOneBStop(rig);
  });

  it('AC4: a RED work turn accepted out of its error at an `auto` step stops with (b): one raise and exactly one engine `auto-halt` entry', async () => {
    h.defResult = h.resolved(h.redDef());
    const { rig, engine } = wired(undefined, makeFakeCompletionPredicates({ workingTreeTestPaths: async () => ({ ok: true, paths: ['tests/a.test.ts'] }) }));
    h.enterAndInjectWork(engine);
    h.writeResult(examplePhaseResult('failed-assertion'));
    engine.onStall();
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: TURN_KEY, status: 'error' });
    engine.routeOut(h.repo, STEP, TURN_KEY, 'accept');
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ turnKey: TURN_KEY, status: 'complete' });
    expectOneBStop(rig);
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
  // #137 S2: each of (a), (b), (g), (h) and (i) is shown as its own letter row, never the generic one.
  async function expectHalt(rig: Rig, letter: AutoHaltReason): Promise<void> {
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(rig.notify).toHaveBeenCalledTimes(1);
    expectLetterShown(v, letter);
    expect(autoHalts(rig)).toHaveLength(1);
    expect(parseAutoHaltReasons(autoHalts(rig)[0])).toContain(letter);
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
    await expectHalt(rig, 'a');
  });

  it('(a) negative: a round report whose every disposition is settled leaves a clean gate to the engine approve', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.gate.loopRunEvent(repoDir, STEP, 'review-plan', { roundReport: roundReportWithDisposition(['summary'], ['p1'], 'fixed') });
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => [a.step, a.decider])).toEqual([[STEP, 'engine']]);
    expect(autoHalts(rig)).toEqual([]);
  });

  it('(a): an unreadable round report after a settled one halts a clean gate (the earlier report does not stand in)', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.gate.loopRunEvent(repoDir, STEP, 'review-plan', { roundReport: roundReportWithDisposition(['summary'], ['p1'], 'fixed') });
    rig.gate.loopRunEvent(repoDir, STEP, 'review-plan', { roundReport: null });
    await expectHalt(rig, 'a');
  });

  it('(b): an accepted failed turn holds for the rest of the loop run', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.gate.loopRunEvent(repoDir, STEP, 'review-plan', 'accepted');
    await expectHalt(rig, 'b');
  });

  it('(b): a loop run that ended in error halts; a Retry clears it and the clean gate is approved', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.gate.loopRunEvent(repoDir, STEP, TURN, 'error');
    await expectHalt(rig, 'b');

    const fresh = makeRig();
    startTrusted(fresh);
    fresh.gate.loopRunEvent(repoDir, STEP, TURN, 'error');
    fresh.gate.loopRunEvent(repoDir, STEP, TURN, 'retried');
    await reachGate(fresh, 'clean');
    expect(fresh.approvals.map((a) => a.decider)).toEqual(['engine']);
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

  it('a resolution at the preparer leaves the clean gate to the engine', async () => {
    const rig = makeRig();
    const preparerResolve = composeLoopBindingResolve(rig.gate, composeObservedResolveDef(ctxFor));
    defNow = plantedResolution(repoDir);
    current = startRun(loopSteps('auto'));
    rig.gate.bindAtStart(repoDir, current, 0);
    rig.gate.commitStart(repoDir);
    expect(preparerResolve(repoDir, STEP, LOOP).ok).toBe(true);
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
  });

  // Plan AC5 row (S2): the first-run leg deletes the operator config root before Start.
  it.each([
    ['an existing operator root', false],
    ['the operator config root deleted before Start (first run)', true],
  ] as const)('a def only in the app-bundled tier, copied to the operator tier on entry, with %s: the clean gate advances with no (g) and no (l)', async (_label, firstRun) => {
    const operatorRoot = mkdtempSync(join(tmpdir(), 'autogate-operator-'));
    try {
      const opTiers: LoopDefV2Tiers = { operator: join(operatorRoot, 'loops-v2'), appBundled: join(appDir, 'loops-v2'), retired: null };
      if (!firstRun) mkdirSync(opTiers.operator!, { recursive: true });
      else rmSync(operatorRoot, { recursive: true, force: true });
      const opCtxFor = (dir: string): LoopDefV2Context => ({ tiers: opTiers, repoDir: dir });
      const atStart = resolveLoopDefV2(LOOP, opCtxFor(repoDir));
      expect(atStart).toMatchObject({ ok: true, tierRoot: opTiers.appBundled });
      defNow = atStart.ok ? {} : null;

      const rig = makeRig();
      const observed = composeObservedResolveDef(opCtxFor);
      const preparerResolve = composeLoopBindingResolve(rig.gate, observed);
      current = startRun(loopSteps('auto'));
      rig.gate.bindAtStart(repoDir, current, 0);
      rig.gate.commitStart(repoDir);
      const entered = preparerResolve(repoDir, STEP, LOOP);
      expect(entered).toMatchObject({ ok: true, tierRoot: opTiers.appBundled });
      if (entered.ok) migrateBundledLoopDefOnEntry({ loop: LOOP }, entered, { appBundled: opTiers.appBundled, operator: opTiers.operator });

      const turnTime = observed(repoDir, LOOP);
      expect(turnTime.ok).toBe(true);
      if (!firstRun) expect(existsSync(join(opTiers.operator!, LOOP, `${LOOP}.yaml`))).toBe(true);
      if (existsSync(join(opTiers.operator!, LOOP, `${LOOP}.yaml`))) expect(turnTime).toMatchObject({ tierRoot: opTiers.operator });
      else expect(turnTime).toMatchObject({ tierRoot: opTiers.appBundled });

      await reachGate(rig, 'clean');
      expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
      expect(autoHalts(rig)).toEqual([]);
      const shown = rig.view().autoGate?.haltReasons.map((r) => r.reason) ?? [];
      expect(shown).not.toContain('g');
      expect(shown).not.toContain('l');
    } finally {
      rmSync(operatorRoot, { recursive: true, force: true });
    }
  });

  it('(i): an earlier engine approve whose effect failed halts the next clean gate', async () => {
    const rig = makeRig();
    current = startRun([
      { id: STEP, kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
      { id: 'second', kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
    ]);
    rig.gate.bindAtStart(repoDir, current, 0);
    rig.gate.commitStart(repoDir);
    rig.gate.beginLoopRun(repoDir, STEP);
    rig.outcome({ kind: 'advanced', effectFailures: ['gh update-issue-body exited 1'] });
    await reachGate(rig, 'clean');
    expect(rig.approvals).toHaveLength(1);

    rig.gate.beginLoopRun(repoDir, 'second');
    await reachGate(rig, 'clean', 'verdict', repoDir, 'second');
    expect(rig.approvals).toHaveLength(1);
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expectLetterShown(v, 'i');
    expect(rig.notify).toHaveBeenCalledTimes(1);
    expect(autoHalts(rig)).toHaveLength(1);
    expect(parseAutoHaltReasons(autoHalts(rig)[0])).toContain('i');
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
  it('(a) + (c) together write exactly one `auto-halt` entry naming both, and two `haltReasons` rows', async () => {
    const rig = makeRig();
    startTrusted(rig);
    armInterrupt(repoDir, 'some-other-step');
    rig.gate.loopRunEvent(repoDir, STEP, 'review-plan', { roundReport: roundReportWithDisposition(['summary'], ['p1'], 'needs a human') });
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    const halts = autoHalts(rig);
    expect(halts).toHaveLength(1);
    expect([...(parseAutoHaltReasons(halts[0]) ?? [])].sort()).toEqual(['a', 'c']);
    expect((rig.view().autoGate?.haltReasons.map((r) => r.reason) ?? []).sort()).toEqual(['a', 'c']);
  });

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

describe('autoGate — every engine approve outcome other than `advanced` halts the gate (N9b.6(k)/(l), #137 S1)', () => {
  it.each([
    ['refused', { kind: 'refused', reason: 'the run-state no longer matches the gate' } as GateApproveOutcome, 1],
    ['accept-failed', { kind: 'accept-failed', reason: 'ENOSPC' } as GateApproveOutcome, 0],
    ['blocked', { kind: 'blocked' } as GateApproveOutcome, 1],
    ['preview-raised', { kind: 'preview-raised' } as GateApproveOutcome, 0],
    ['abandoned', { kind: 'abandoned' } as GateApproveOutcome, 1],
  ])('%s: human-needed, no longer deciding, the halt shown, no failed-effect marker, and only the `auto-halt` entries the controller owns', async (_label, outcome, entries) => {
    const rig = makeRig();
    startTrusted(rig);
    rig.outcome(outcome);
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate?.deciding).toBe(false);
    expect(v.autoGate?.failedEffect).toBeUndefined();
    expect(v.autoGate?.haltGeneric).toBe(true);
    expect(autoHalts(rig)).toHaveLength(entries);
  });

  it.each(['throw', 'reject'] as const)('an engine approve that %ss: human-needed, the failed-effect marker set, and one `auto-halt` entry naming (l)', async (failure) => {
    const rig = makeRig();
    startTrusted(rig);
    rig.outcome(failure);
    await reachGate(rig, 'clean');
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate?.deciding).toBe(false);
    expect(v.autoGate?.failedEffect?.state).toBe('set');
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['l']]);
  });

  it('an interrupt armed after the evaluation but before the claim is refused at the claim: no accept, human-needed, (c) shown and recorded', async () => {
    const rig = makeRig();
    startTrusted(rig);
    const release = rig.hold();
    await reachGate(rig, 'clean');
    armInterrupt(repoDir, 'next');
    release();
    await flush();
    expect(readAppLoopState(repoDir)?.status).toBe('complete');
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate?.haltReasons.map((r) => r.reason)).toContain('c');
    expect(autoHalts(rig).flatMap((c) => parseAutoHaltReasons(c) ?? [])).toContain('c');
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
    rig.gate.bindAtStart(repoDir, current, 0);
    rig.gate.beginLoopRun(repoDir, STEP);
    rig.gate.commitStart(repoDir);
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
  });

  it('a Start that never began (discarded) leaves no binding behind: a later clean gate is not engine-decided (paired with the control above)', async () => {
    const rig = makeRig();
    current = startRun(loopSteps('auto'));
    rig.gate.bindAtStart(repoDir, current, 0);
    rig.gate.discardStart(repoDir);
    rig.gate.beginLoopRun(repoDir, STEP);
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    expect(rig.view()).not.toHaveProperty('autoGate');
  });

  it('per-loop-run flags reset at step entry: an error in one loop run does not hold for the next', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.gate.loopRunEvent(repoDir, STEP, TURN, 'error');
    rig.gate.beginLoopRun(repoDir, STEP);
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
  });

  // Plan row "Per-loop-run flags reset at the next step", through the production preparer composition.
  it('a per-loop-run flag raised in one `auto` step does not hold the next step entered through the preparer', async () => {
    const rig = makeRig();
    const preparerResolve = composeLoopBindingResolve(rig.gate, composeObservedResolveDef(ctxFor));
    defNow = plantedResolution(repoDir);
    current = startRun([
      { id: STEP, kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
      { id: 'second', kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
    ]);
    rig.gate.bindAtStart(repoDir, current, 0);
    rig.gate.commitStart(repoDir);
    expect(preparerResolve(repoDir, STEP, LOOP).ok).toBe(true);
    rig.gate.loopRunEvent(repoDir, STEP, TURN, 'error');
    expect(preparerResolve(repoDir, 'second', LOOP).ok).toBe(true);
    await reachGate(rig, 'clean', 'verdict', repoDir, 'second');
    expect(rig.approvals.map((a) => [a.step, a.decider])).toEqual([['second', 'engine']]);
  });

  // The same plan row's (a) leg (S2), and its accepted-failed-review (b) leg: step A halts on its own letter, and the
  // operator's decision there leaves step B's clean gate to the engine.
  it.each([
    ['a `needs a human` round report (a)', 'a', { roundReport: roundReportWithDisposition(['summary'], ['p1'], 'needs a human') }],
    ['an accepted failed review round (b)', 'b', 'accepted'],
  ] as const)('step A held by %s: A halts on that letter, and step B entered through the preparer is engine-approved with no `auto-halt` of its own', async (_label, letter, event) => {
    const rig = makeRig();
    const preparerResolve = composeLoopBindingResolve(rig.gate, composeObservedResolveDef(ctxFor));
    defNow = plantedResolution(repoDir);
    current = startRun([
      { id: STEP, kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
      { id: 'second', kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
    ]);
    rig.gate.bindAtStart(repoDir, current, 0);
    rig.gate.commitStart(repoDir);
    expect(preparerResolve(repoDir, STEP, LOOP).ok).toBe(true);
    rig.gate.loopRunEvent(repoDir, STEP, 'review-plan', event);
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    expectLetterShown(rig.view(), letter);
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([[letter]]);

    expect(preparerResolve(repoDir, 'second', LOOP).ok).toBe(true);
    await reachGate(rig, 'clean', 'verdict', repoDir, 'second');
    expect(rig.approvals.map((a) => [a.step, a.decider])).toEqual([['second', 'engine']]);
    expect(autoHalts(rig)).toHaveLength(1);
  });

  it('a second loop run entered at the same step keeps the Start-bound authority: its clean gate is engine-approved again', async () => {
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    rig.gate.beginLoopRun(repoDir, STEP);
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
    const observed = composeObservedResolveDef((dir) => ({ tiers: tiers(), repoDir: dir }));
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
    await vi.waitFor(() => expect(git.git(b, ['rev-list', '--count', 'HEAD'])).toBe('2'), { timeout: 10_000 });
    expect(git.git(b, ['show', '--name-only', '--format=', 'HEAD']).split('\n')).toContain('src/b.ts');
    expect(git.git(a, ['rev-parse', 'HEAD'])).toBe(headA);
  });
});

// #137 S2 — the visible halt reasons (b) and (i), the failed-effect marker's lifetime, and the run-end report.
const STEPS_MARKER: FlowStepDef[] = [
  { id: STEP, kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
  { id: 'human-step', kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'human' },
  { id: 'third', kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
  { id: 'next', kind: 'manual' },
];
const EFFECT_FAILURE = 'gh update-issue-body exited 1';

/** Start `steps`, enter the first step and let its clean gate be engine-approved with a failed effect. */
async function markerSet(rig: Rig, steps: FlowStepDef[] = STEPS_MARKER): Promise<void> {
  startTrusted(rig, steps);
  rig.outcome({ kind: 'advanced', effectFailures: [EFFECT_FAILURE] });
  await reachGate(rig, 'clean');
  expect(rig.approvals).toHaveLength(1);
  rig.outcome({ kind: 'advanced', effectFailures: [] });
}

async function enterAndReach(rig: Rig, step: string): Promise<void> {
  rig.gate.beginLoopRun(repoDir, step);
  await reachGate(rig, 'clean', 'verdict', repoDir, step);
}

const flowAt = (steps: FlowStepDef[], stepName: string, status: FlowStateView['status'] = 'in_progress'): FlowStateView => ({
  stepName,
  runStarted: 'never-started' as const,
  steps: steps.map((st) => st.id),
  position: Math.max(1, steps.findIndex((st) => st.id === stepName) + 1),
  total: steps.length,
  status,
});

describe('autoGate — (b) at the error stop itself (AC4, #137 S2)', () => {
  it('an `auto` step\'s loop run ending in error shows (b) at the error stop and writes one engine entry; the Accept after it writes no second', async () => {
    const rig = makeRig();
    startTrusted(rig);
    writeAppLoopState(repoDir, { loop: LOOP, step: STEP, turnKey: TURN, status: 'error', errorReason: 'turn stalled' }, FIXED);
    rig.gate.loopRunEvent(repoDir, STEP, TURN, 'error');
    await flush();
    expectLetterShown(rig.view(), 'b');
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['b']]);

    writeAppLoopState(repoDir, { loop: LOOP, step: STEP, turnKey: TURN, status: 'complete', round: 1 }, FIXED);
    rig.gate.loopRunEvent(repoDir, STEP, TURN, 'accepted');
    await flush();
    expectLetterShown(rig.view(), 'b');
    expect(autoHalts(rig)).toHaveLength(1);
  });

  it('a Retry out of the error stop clears (b): the turn back at work shows no halt reason', async () => {
    const rig = makeRig();
    startTrusted(rig);
    writeAppLoopState(repoDir, { loop: LOOP, step: STEP, turnKey: TURN, status: 'error', errorReason: 'turn stalled' }, FIXED);
    rig.gate.loopRunEvent(repoDir, STEP, TURN, 'error');
    await flush();
    expectLetterShown(rig.view(), 'b');
    writeAppLoopState(repoDir, { loop: LOOP, step: STEP, turnKey: TURN, status: 'working', round: 1 }, FIXED);
    rig.gate.loopRunEvent(repoDir, STEP, TURN, 'retried');
    await flush();
    expect(rig.view().autoGate?.haltReasons ?? []).toEqual([]);
  });
});

describe('autoGate — the failed-effect marker across gates of either authority (AC13, N9b.5(d), #137 S2)', () => {
  const decisions: { repoKey: string; step: string; turnKey: string; option: string }[] = [];
  const advanced: string[] = [];
  let currentStep = STEP;
  beforeEach(() => {
    decisions.length = 0;
    advanced.length = 0;
    currentStep = STEP;
  });

  function runnersFor(rig: Rig): ReturnType<typeof composeHumanDecisionRunners<string>> {
    expect(typeof composeHumanDecisionRunners).toBe('function');
    return composeHumanDecisionRunners(rig.gate, {
      decide: async (repoKey: string, step: string, turnKey: string, option: GateDecisionOption) => {
        decisions.push({ repoKey, step, turnKey, option });
        return true;
      },
      advance: (repoKey: string) => {
        advanced.push(repoKey);
        return `advanced:${repoKey}`;
      },
      currentStep: () => currentStep,
    });
  }

  it('the next `human` gate shows the set marker with its failure text, and no halt reason or `auto-halt` entry of its own', async () => {
    const rig = makeRig();
    await markerSet(rig);
    await enterAndReach(rig, 'human-step');
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate?.failedEffect).toMatchObject({ state: 'set' });
    expect(v.autoGate?.failedEffect?.detail).toContain(EFFECT_FAILURE);
    expect(v.autoGate?.haltReasons ?? []).toEqual([]);
    expect(autoHalts(rig)).toEqual([]);
  });

  it('a human decision at the marked gate, through the composed runners, clears the marker: the next `auto` gate is engine-approved with no (i)', async () => {
    const rig = makeRig();
    const runners = runnersFor(rig);
    await markerSet(rig);
    await enterAndReach(rig, 'human-step');
    await expect(runners.decide(repoDir, 'human-step', TURN, 'approve')).resolves.toBe(true);
    expect(decisions).toEqual([{ repoKey: repoDir, step: 'human-step', turnKey: TURN, option: 'approve' }]);
    expect(rig.view().autoGate?.failedEffect).toBeUndefined();

    await enterAndReach(rig, 'third');
    expect(rig.approvals.map((a) => a.step)).toEqual([STEP, 'third']);
    expect(autoHalts(rig).flatMap((c) => parseAutoHaltReasons(c) ?? [])).not.toContain('i');
  });

  // N9b.5(d): the clearing decision may be at an `auto` gate the marker halted with (i), not only at a `human` one.
  it('a human decision at an `auto` gate halted with (i), through the composed runners, clears the marker: the next `auto` gate is engine-approved', async () => {
    const rig = makeRig();
    const runners = runnersFor(rig);
    const steps: FlowStepDef[] = [STEPS_MARKER[0], STEPS_MARKER[2], { id: 'fourth', kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' }, STEPS_MARKER[3]];
    await markerSet(rig, steps);
    await enterAndReach(rig, 'third');
    expectLetterShown(rig.view(), 'i');
    expect(rig.approvals.map((a) => a.step)).toEqual([STEP]);
    await expect(runners.decide(repoDir, 'third', TURN, 'approve')).resolves.toBe(true);
    expect(rig.view().autoGate?.failedEffect).toBeUndefined();

    await enterAndReach(rig, 'fourth');
    expect(rig.approvals.map((a) => a.step)).toEqual([STEP, 'fourth']);
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['i']]);
  });

  it.each(['request-changes', 'redo', 'back-to-red'] as const)('a `%s` at the marked gate, through the composed runners, clears the marker', async (option) => {
    const rig = makeRig();
    const runners = runnersFor(rig);
    await markerSet(rig);
    await enterAndReach(rig, 'human-step');
    await runners.decide(repoDir, 'human-step', TURN, option, 'note');
    expect(decisions.map((d) => d.option)).toEqual([option]);
    expect(rig.view().autoGate?.failedEffect).toBeUndefined();
  });

  it('a stale decision naming a step the flow has left, through the composed runners, does not clear the marker the current gate shows (negative pair)', async () => {
    const rig = makeRig();
    const runners = runnersFor(rig);
    await markerSet(rig);
    await enterAndReach(rig, 'human-step');
    currentStep = 'human-step';
    await runners.decide(repoDir, STEP, TURN, 'approve');
    expect(rig.view().autoGate?.failedEffect?.state).toBe('set');
  });

  it('a manual Advance at the marked gate, through the composed runners, clears the marker: the next `auto` gate does not halt with (i)', async () => {
    const rig = makeRig();
    const runners = runnersFor(rig);
    await markerSet(rig);
    await enterAndReach(rig, 'human-step');
    currentStep = 'human-step';
    expect(runners.advance(repoDir, 'human-step')).toBe(`advanced:${repoDir}`);
    expect(advanced).toEqual([repoDir]);
    expect(rig.view().autoGate?.failedEffect).toBeUndefined();

    await enterAndReach(rig, 'third');
    expect(rig.approvals.map((a) => a.step)).toEqual([STEP, 'third']);
  });

  it('a stale manual Advance naming a step the flow has left is refused: no advance, and the gate it did not see keeps the marker and halts with (i)', async () => {
    const rig = makeRig();
    const runners = runnersFor(rig);
    await markerSet(rig, [STEPS_MARKER[0], STEPS_MARKER[2], STEPS_MARKER[3]]);
    currentStep = 'third';
    rig.gate.beginLoopRun(repoDir, 'third');
    expect(runners.advance(repoDir, STEP)).toBeNull();
    expect(advanced).toEqual([]);
    await reachGate(rig, 'clean', 'verdict', repoDir, 'third');
    const v = rig.view();
    expect(v.autoGate?.failedEffect?.state).toBe('set');
    expectLetterShown(v, 'i');
    expect(rig.approvals.map((a) => a.step)).toEqual([STEP]);
  });
});

describe('autoGate — a run that ends with the marker set reports it (AC13 run end, N9b.5(d), #137 S2)', () => {
  const RUN_END_STEPS: FlowStepDef[] = [
    { id: STEP, kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
    { id: 'finalize', kind: 'manual' },
  ];

  function recorded(rig: Rig): { record: ReturnType<typeof composeRecordFlowTransition>; transitions: string[] } {
    const transitions: string[] = [];
    const record = composeRecordFlowTransition({ recordTransition: (_k, kind, _b, after) => void transitions.push(`${kind}:${after.stepName}:${after.status}`) }, rig.gate);
    return { record, transitions };
  }

  it('reaching the final manual step with the marker set emits the failure once and writes one (i) entry; the advance to `done` adds neither', async () => {
    const rig = makeRig();
    await markerSet(rig, RUN_END_STEPS);
    const { record, transitions } = recorded(rig);
    record(repoDir, 'advance', flowAt(RUN_END_STEPS, STEP), flowAt(RUN_END_STEPS, 'finalize'));
    expect(rig.errors.map((e) => e.repoDir)).toEqual([repoDir]);
    expect(rig.errors[0].reason).toContain(EFFECT_FAILURE);
    const halts = autoHalts(rig);
    expect(halts.map((c) => ({ reasons: parseAutoHaltReasons(c), decider: gateDecisionDecider(c) }))).toEqual([{ reasons: ['i'], decider: 'engine' }]);

    record(repoDir, 'advance', flowAt(RUN_END_STEPS, 'finalize'), flowAt(RUN_END_STEPS, 'finalize', 'done'));
    expect(rig.errors).toHaveLength(1);
    expect(autoHalts(rig)).toHaveLength(1);
    expect(transitions).toEqual(['advance:finalize:in_progress', 'advance:finalize:done']);
  });

  it('reaching `done` straight from the marked `auto` step emits the failure once and writes one (i) entry', async () => {
    const rig = makeRig();
    const only: FlowStepDef[] = [RUN_END_STEPS[0]];
    await markerSet(rig, only);
    const { record } = recorded(rig);
    record(repoDir, 'advance', flowAt(only, STEP), flowAt(only, STEP, 'done'));
    expect(rig.errors).toHaveLength(1);
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['i']]);
  });

  // Plan row "Run end with a marker": the reopen-slice caller (`reopenSliceFlow`, an `undo` back to the slice's RED
  // step) goes through the same composed recorder, so it neither reports early nor double-reports at run end.
  it('with the marker set, a reopen-slice `undo` is recorded and reports nothing; the run\'s later end emits once and writes one (i) entry', async () => {
    const rig = makeRig();
    await markerSet(rig, RUN_END_STEPS);
    const { record, transitions } = recorded(rig);
    record(repoDir, 'undo', flowAt(RUN_END_STEPS, STEP), flowAt(RUN_END_STEPS, STEP));
    expect(transitions).toEqual([`undo:${STEP}:in_progress`]);
    expect(rig.errors).toEqual([]);
    expect(autoHalts(rig)).toEqual([]);

    record(repoDir, 'advance', flowAt(RUN_END_STEPS, STEP), flowAt(RUN_END_STEPS, 'finalize'));
    record(repoDir, 'advance', flowAt(RUN_END_STEPS, 'finalize'), flowAt(RUN_END_STEPS, 'finalize', 'done'));
    expect(rig.errors).toHaveLength(1);
    expect(rig.errors[0].reason).toContain(EFFECT_FAILURE);
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['i']]);
    expect(transitions).toHaveLength(3);
  });

  it('negative: a run reaching its end with no marker set emits nothing and writes no `auto-halt` entry', async () => {
    const rig = makeRig();
    startTrusted(rig, RUN_END_STEPS);
    await reachGate(rig, 'clean');
    const { record } = recorded(rig);
    record(repoDir, 'advance', flowAt(RUN_END_STEPS, STEP), flowAt(RUN_END_STEPS, 'finalize'));
    record(repoDir, 'advance', flowAt(RUN_END_STEPS, 'finalize'), flowAt(RUN_END_STEPS, 'finalize', 'done'));
    expect(rig.errors).toEqual([]);
    expect(autoHalts(rig)).toEqual([]);
  });

  it('negative: an advance into a later loop step with the marker set reports nothing yet (that gate shows it)', async () => {
    const rig = makeRig();
    await markerSet(rig);
    const { record } = recorded(rig);
    record(repoDir, 'advance', flowAt(STEPS_MARKER, STEP), flowAt(STEPS_MARKER, 'human-step'));
    expect(rig.errors).toEqual([]);
    expect(autoHalts(rig)).toEqual([]);
  });
});
