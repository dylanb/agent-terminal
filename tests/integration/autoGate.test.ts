import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createAutoGate,
  defResolutionOf,
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
import { readGateRunState } from '../../src/main/gateRunState';
import {
  armInterrupt,
  clearBaselineCommit,
  loopAreaFile,
  readAppLoopState,
  readArmedInterrupt,
  readBaselineCommit,
  readChangedTests,
  recordBaselineCommit,
  recordChangedTests,
  writeAppLoopState,
  type AppLoopRunState,
} from '../../src/main/appLoopState';
import { writeLoopCapabilities } from '../helpers/loopCapabilities';
import { installPathGitStub } from '../helpers/pathGitStub';
import { shellQuote } from '../../src/shared/shellQuote';
import { MAX_CAPABILITIES_BYTES } from '../../src/shared/loopCapabilities';
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
import { exampleConsolidatorOutput } from '../../src/shared/consolidatorOutput';
import type { LoopCompletionPredicates } from '../../src/main/loopCompletionPredicates';
import { AUTO_GATE_DECISION_DEFAULT_MS, resolveRuntimeConfig } from '../../src/main/runtimeConfig';
import { verdictOutput } from '../helpers/consolidatorOutputs';

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

function makeRig(opts: { approveAttached?: boolean; auditThrows?: boolean; defThrows?: () => boolean; defFor?: (loop: string) => DefResolution | null; runInProgress?: () => boolean; onPush?: (repoKey: string) => void; env?: NodeJS.ProcessEnv } = {}): Rig {
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
    opts.onPush?.(repoKey);
    const v = view(repoKey);
    views.push(v);
    notifier.observe(repoKey, flowView(v));
  };
  gate = createAutoGate({
    audit: (dir, cmd, exit) => {
      if (opts.auditThrows) throw new Error('audit sink unavailable');
      audits.push({ repoDir: dir, cmd, exit });
    },
    resolveDef: (_dir, loop) => {
      if (opts.defThrows?.()) throw new Error('def read failed');
      return opts.defFor ? opts.defFor(loop) : defNow;
    },
    currentRun: () => {
      return current;
    },
    runInProgressAt: () => {
      return opts.runInProgress?.() ?? true;
    },
    onViewChanged: (repoKey) => pushView(repoKey),
    emitError: (dir: string, reason: string) => void errors.push({ repoDir: dir, reason }),
    setTimer: (cb, ms) => clock.setTimer(cb, ms),
    clearTimer: (h) => clock.clearTimer(h),
    decisionBoundMs: resolveRuntimeConfig(opts.env ?? {}).autoGateDecisionMs,
  } as AutoGateDeps);
  if (opts.approveAttached !== false) gate.attachApprove((dir, step, turnKey, decider) => {
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

function expectReasonShown(v: FlowLoopView, reason: AutoHaltReason): void {
  expect(v.autoGate?.haltReasons.map((r) => r.reason) ?? []).toContain(reason);
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
    h.completeConsolidate(engine, 1, verdictOutput('clean'));
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
    h.completeConsolidate(engine, 1, verdictOutput('clean'));
    await flush();
    expect(rig.view(h.repo).autoGate?.haltReasons.map((r) => r.reason) ?? []).toContain('interrupt-armed');
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
    h.completeConsolidate(engine, 1, verdictOutput('clean'));
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ step: STEP, turnKey: CONSOLIDATE_KEY, status: 'complete' });
    expect(rig.approvals).toEqual([]);
    const v = rig.view(h.repo);
    expect(v.humanNeeded).toBe(true);
    expect(rig.notify).toHaveBeenCalledTimes(1);
    expectReasonShown(v, 'needs-a-human');
    expect(autoHalts(rig)).toHaveLength(1);
    expect(parseAutoHaltReasons(autoHalts(rig)[0])).toContain('needs-a-human');
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
    h.completeConsolidate(engine, 1, verdictOutput('clean'));
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
    h.completeConsolidate(engine, 1, verdictOutput('clean'));
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
    expectReasonShown(v, 'loop-error');
    expect(rig.notify).toHaveBeenCalledTimes(1);
    expect(autoHalts(rig)).toHaveLength(1);
    expect(parseAutoHaltReasons(autoHalts(rig)[0])).toContain('loop-error');
  });

  it('a turn resumed by its done file after a stall at an `auto` step no longer holds (b): the clean gate that follows is approved by the engine', async () => {
    const { rig, engine } = wired();
    h.enterAndInjectWork(engine);
    engine.onStall();
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ step: STEP, turnKey: TURN_KEY, status: 'error' });
    h.driveFromWorkToGate(engine);
    await flush();
    expect(rig.view(h.repo).autoGate?.haltReasons ?? []).toEqual([]);
    expect(rig.approvals.map((a) => [a.repoDir, a.step, a.decider])).toEqual([[h.repo, STEP, 'engine']]);
  });

  // AC4 (#137 S2): the error stop itself shows and records (b), and the Accept out of it adds no second entry.
  function expectOneBStop(rig: Rig): void {
    const v = rig.view(h.repo);
    expect(v.humanNeeded).toBe(true);
    expectReasonShown(v, 'loop-error');
    expect(rig.notify).toHaveBeenCalledTimes(1);
    const halts = autoHalts(rig);
    expect(halts).toHaveLength(1);
    expect(parseAutoHaltReasons(halts[0])).toContain('loop-error');
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

// Plan AC11 row (S3), integration cell: the real `createAutoGate` answers the engine's `interruptArmed`, and a real
// `armed-interrupt.yaml` is the arm (N9b.6(c)).
describe('autoGate — the interrupt arm is run-scoped in a run with an `auto` step, and consumed (AC11, N9b.6(c), #137 S3)', () => {
  const h = createAppLoopEngineHarness();
  beforeEach(() => h.setUp());
  afterEach(() => h.tearDown());

  const LATER_AUTO: FlowStepDef = { id: 'later', kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' };

  function wiredWith(steps: FlowStepDef[]): { rig: Rig; engine: ReturnType<typeof h.makeEngine> } {
    repoDir = h.repo;
    const rig = makeRig();
    const g = rig.gate;
    const engine = h.makeEngine(undefined, undefined, TEST_BRANCH, {
      onViewChanged: () => rig.pushView(h.repo),
      gateReaching: g.gateReaching,
      gateReached: g.gateReached,
      gateNotReached: g.gateNotReached,
      loopRunEvent: g.loopRunEvent,
      interruptArmed: g.interruptArmed,
      consumeInterrupt: g.consumeInterrupt,
    });
    rig.useEngine(engine);
    startTrusted(rig, steps, h.repo);
    return { rig, engine };
  }

  it('an arm naming another step, at the consolidation of `auto` step Y that says `another round`: Y stops at its gate with (c), no engine approve, and the arm file is consumed', async () => {
    const { rig, engine } = wiredWith(loopSteps('auto'));
    h.driveToConsolidateInjected(engine);
    armInterrupt(h.repo, 'some-earlier-step');
    h.completeConsolidate(engine, 1, exampleConsolidatorOutput('another round', ROSTER));
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ step: STEP, status: 'complete', round: 1 });
    expect(rig.approvals).toEqual([]);
    expectReasonShown(rig.view(h.repo), 'interrupt-armed');
    expect(autoHalts(rig).flatMap((c) => parseAutoHaltReasons(c) ?? [])).toContain('interrupt-armed');
    expect(readArmedInterrupt(h.repo)).toBeNull();
  });

  it('in a run with no `auto` step, an arm naming another step is not honoured at Y: the clean gate is unchanged and the arm stays (AC7)', async () => {
    const { rig, engine } = wiredWith(loopSteps('human'));
    h.driveToConsolidateInjected(engine);
    armInterrupt(h.repo, 'some-earlier-step');
    h.completeConsolidate(engine, 1, verdictOutput('clean'));
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ step: STEP, status: 'complete', verdict: 'clean' });
    expect(rig.view(h.repo)).not.toHaveProperty('autoGate');
    expect(autoHalts(rig)).toEqual([]);
    expect(readArmedInterrupt(h.repo)?.step).toBe('some-earlier-step');
  });

  it('in a run that has an `auto` step, an arm naming another step at a `human` step Y whose consolidation says `another round`: Y stops at its gate, the arm is consumed, and no `auto-halt` entry is written (N9b.3)', async () => {
    const { rig, engine } = wiredWith([loopSteps('human')[0], LATER_AUTO, { id: 'next', kind: 'manual' }]);
    h.driveToConsolidateInjected(engine);
    armInterrupt(h.repo, 'some-earlier-step');
    h.completeConsolidate(engine, 1, exampleConsolidatorOutput('another round', ROSTER));
    await flush();
    const state = readAppLoopState(h.repo);
    expect(state).toMatchObject({ step: STEP, status: 'complete', round: 1 });
    expect(readArmedInterrupt(h.repo)).toBeNull();
    expect(autoHalts(rig)).toEqual([]);
    expect(rig.approvals).toEqual([]);
  });

  it('an unreadable `armed-interrupt.yaml` at the consolidation of `auto` step Y that says `another round`: Y stops at its gate with (h), not (c), and no engine approve', async () => {
    const { rig, engine } = wiredWith(loopSteps('auto'));
    h.driveToConsolidateInjected(engine);
    armInterrupt(h.repo, STEP);
    writeFileSync(loopAreaFile(h.repo, 'armed-interrupt.yaml')!, 'step: [unclosed\n');
    h.completeConsolidate(engine, 1, exampleConsolidatorOutput('another round', ROSTER));
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ step: STEP, status: 'complete', round: 1 });
    expect(rig.approvals).toEqual([]);
    expectReasonShown(rig.view(h.repo), 'engine-input-missing');
    const recorded = autoHalts(rig).flatMap((c) => parseAutoHaltReasons(c) ?? []);
    expect(recorded).toContain('engine-input-missing');
    expect(recorded).not.toContain('interrupt-armed');
  });

  it('in a run that has an `auto` step, an unreadable `armed-interrupt.yaml` at a `human` step Y whose consolidation says `another round`: Y stops at its gate', async () => {
    const { rig, engine } = wiredWith([loopSteps('human')[0], LATER_AUTO, { id: 'next', kind: 'manual' }]);
    h.driveToConsolidateInjected(engine);
    armInterrupt(h.repo, STEP);
    writeFileSync(loopAreaFile(h.repo, 'armed-interrupt.yaml')!, 'step: [unclosed\n');
    h.completeConsolidate(engine, 1, exampleConsolidatorOutput('another round', ROSTER));
    await flush();
    expect(readAppLoopState(h.repo)).toMatchObject({ step: STEP, status: 'complete', round: 1 });
    expect(rig.approvals).toEqual([]);
  });

  it('the negative pair: with no arm, that `human` step\'s `another round` starts the next round', async () => {
    const { engine } = wiredWith([loopSteps('human')[0], LATER_AUTO, { id: 'next', kind: 'manual' }]);
    h.driveToConsolidateInjected(engine);
    h.completeConsolidate(engine, 1, exampleConsolidatorOutput('another round', ROSTER));
    await flush();
    expect(readAppLoopState(h.repo)?.status).not.toBe('complete');
  });
});

describe('autoGate — the approve-site (c) consumes the arm (AC11, N9b.6(c), #137 S3)', () => {
  it('an arm naming another step, present when a clean `auto` gate is decided: (c) halts it and `armed-interrupt.yaml` is consumed', async () => {
    const rig = makeRig();
    startTrusted(rig);
    armInterrupt(repoDir, 'some-other-step');
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    expectReasonShown(rig.view(), 'interrupt-armed');
    expect(readArmedInterrupt(repoDir)).toBeNull();
  });

  it.skipIf(process.getuid?.() === 0)('a clear that fails is shown with its detail, and the still-armed file is honoured as an arm at the run\'s next `auto` approve', async () => {
    const rig = makeRig();
    current = startRun([
      { id: STEP, kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
      { id: 'second', kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
    ]);
    rig.gate.bindAtStart(repoDir, current, 0);
    rig.gate.commitStart(repoDir);
    rig.gate.beginLoopRun(repoDir, STEP);
    armInterrupt(repoDir, 'some-other-step');
    const loopDir = dirname(loopAreaFile(repoDir, 'armed-interrupt.yaml')!);
    rig.gate.gateReaching(repoDir, STEP, TURN, 'clean', 'verdict');
    writeAppLoopState(repoDir, { loop: LOOP, step: STEP, turnKey: TURN, status: 'complete', round: 1, verdict: 'clean' }, FIXED);
    chmodSync(loopDir, 0o555);
    try {
      rig.gate.gateReached(repoDir, STEP, TURN);
      await flush();
    } finally {
      chmodSync(loopDir, 0o755);
    }
    const c = rig.view().autoGate?.haltReasons.find((r) => r.reason === 'interrupt-armed');
    expect(c?.detail ?? '').toMatch(/could not be cleared/);
    expect(readArmedInterrupt(repoDir)?.step).toBe('some-other-step');
    expect(rig.approvals).toEqual([]);

    rig.gate.beginLoopRun(repoDir, 'second');
    await reachGate(rig, 'clean', 'verdict', repoDir, 'second');
    expect(rig.approvals).toEqual([]);
    expectReasonShown(rig.view(), 'interrupt-armed');
    expect(readArmedInterrupt(repoDir)).toBeNull();
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

  it('a human approve landing on a halted gate leaves it neither human-needed nor showing the halt', async () => {
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'stop for a human');
    expect(rig.view().humanNeeded).toBe(true);
    await composeHumanDecisionRunners(rig.gate, {
      decide: async (dir, step, turnKey) => {
        writeAppLoopState(dir, { loop: LOOP, step, turnKey, status: 'accepted' }, FIXED);
        return true;
      },
      advance: () => 'advanced',
      currentStep: () => STEP,
    }).decide(repoDir, STEP, TURN, 'approve', undefined);
    await flush();
    const v = rig.view();
    expect(v.autoGate?.haltReasons ?? []).toEqual([]);
    expect(v.humanNeeded).toBe(false);
  });

  it.each([
    ['a request-changes that did not land', STEP, TURN, false],
    ['a landed decision for another step', 'other-step', TURN, true],
    ['a landed decision for another turn', STEP, 'other-turn', true],
  ] as const)('%s leaves the halted gate showing its halt', async (_name, step, turnKey, landed) => {
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'stop for a human');
    await composeHumanDecisionRunners(rig.gate, {
      decide: async () => landed,
      advance: () => 'advanced',
      currentStep: () => STEP,
    }).decide(repoDir, step, turnKey, 'request-changes', undefined);
    await flush();
    expect(rig.view().autoGate?.haltReasons).toEqual([{ reason: 'stop-for-a-human' }]);
  });

  it('`another round` reaching the gate on an interrupt halts with (c) and runs no approve', async () => {
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'another round', 'interrupt');
    expect(rig.view().autoGate?.haltReasons.map((r) => r.reason) ?? []).toContain('interrupt-armed');
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
    expectReasonShown(v, letter);
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

  it('(a) and (h): a clean `auto` gate whose step the engine never saw entered halts, with no engine approve', async () => {
    const rig = makeRig();
    current = startRun(loopSteps('auto'));
    rig.gate.bindAtStart(repoDir, current, Date.parse('2026-07-17T12:00:00.000Z'));
    rig.gate.commitStart(repoDir);
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    expectReasonShown(rig.view(), 'needs-a-human');
    expectReasonShown(rig.view(), 'engine-input-missing');
    expect(parseAutoHaltReasons(autoHalts(rig)[0])).toEqual(expect.arrayContaining(['needs-a-human', 'engine-input-missing']));
  });

  it('(a): a round report recording a `needs a human` disposition halts a clean gate', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.gate.loopRunEvent(repoDir, STEP, 'review-plan', { roundReport: roundReportWithDisposition(['summary'], ['p1'], 'needs a human') });
    await expectHalt(rig, 'needs-a-human');
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
    await expectHalt(rig, 'needs-a-human');
  });

  it('(b): an accepted failed turn holds for the rest of the loop run', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.gate.loopRunEvent(repoDir, STEP, 'review-plan', 'accepted');
    await expectHalt(rig, 'loop-error');
  });

  it('(b): a loop run that ended in error halts; a Retry clears it and the clean gate is approved', async () => {
    const rig = makeRig();
    startTrusted(rig);
    rig.gate.loopRunEvent(repoDir, STEP, TURN, 'error');
    await expectHalt(rig, 'loop-error');

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
    expect(rig.view().autoGate?.haltReasons.map((r) => r.reason) ?? []).toContain('interrupt-armed');
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

  // AC5 — `auto` is honoured whatever LoopDef tier supplies the step's def, the repo's own included (v2.184 (9)).
  it('a def only in the repo tier: the clean gate is engine-decided with no halt', async () => {
    rmSync(join(appDir, 'loops-v2'), { recursive: true, force: true });
    plantDef(DEF_YAML, join(repoDir, 'loops'));
    writeFileSync(join(repoDir, '.agent-loop.yaml'), `loops:\n  ${LOOP}: loops/${LOOP}/${LOOP}.yaml\n`);
    const atStart = resolveLoopDefV2(LOOP, ctxFor(repoDir));
    expect(atStart).toMatchObject({ ok: true, tierRoot: repoDir });

    const rig = makeRig();
    const observed = composeObservedResolveDef(ctxFor);
    const preparerResolve = composeLoopBindingResolve(rig.gate, observed);
    defNow = defResolutionOf(observed(repoDir, LOOP));
    current = startRun(loopSteps('auto'));
    rig.gate.bindAtStart(repoDir, current, 0);
    rig.gate.commitStart(repoDir);
    expect(preparerResolve(repoDir, STEP, LOOP)).toMatchObject({ ok: true, tierRoot: repoDir });
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
    expect(autoHalts(rig)).toEqual([]);
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
      expect(shown).not.toContain('approve-not-persisted');
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
    expectReasonShown(v, 'failed-effect');
    expect(rig.notify).toHaveBeenCalledTimes(1);
    expect(autoHalts(rig)).toHaveLength(1);
    expect(parseAutoHaltReasons(autoHalts(rig)[0])).toContain('failed-effect');
  });

  it('a `red`-completion step is not a frozen-check step, so its clean gate is approved by the engine', async () => {
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
    expect([...(parseAutoHaltReasons(halts[0]) ?? [])].sort()).toEqual(['interrupt-armed', 'needs-a-human']);
    expect((rig.view().autoGate?.haltReasons.map((r) => r.reason) ?? []).sort()).toEqual(['interrupt-armed', 'needs-a-human']);
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
    expect([...(parseAutoHaltReasons(halts[0]) ?? [])].sort()).toEqual(['frozen-check-unavailable', 'interrupt-armed']);
    expect((rig.view().autoGate?.haltReasons.map((r) => r.reason) ?? []).sort()).toEqual(['frozen-check-unavailable', 'interrupt-armed']);
  });

  it('(h): an `armed-interrupt.yaml` that cannot be parsed, present when the clean gate is decided, halts and runs no approve (N9b.5(b))', async () => {
    const rig = makeRig();
    startTrusted(rig);
    armInterrupt(repoDir, STEP);
    writeFileSync(loopAreaFile(repoDir, 'armed-interrupt.yaml')!, 'step: [unclosed\n');
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    expectReasonShown(rig.view(), 'engine-input-missing');
  });

  it.each([
    ['not a mapping', '- step\n'],
    ['another schema version', `schema_version: 999\nstep: ${STEP}\n`],
    ['no step', 'schema_version: 1\n'],
    ['an empty step', 'schema_version: 1\nstep: ""\n'],
  ])('(h): an `armed-interrupt.yaml` that parses but is %s halts the clean gate and runs no approve (N9b.5(b))', async (_label, body) => {
    const rig = makeRig();
    startTrusted(rig);
    armInterrupt(repoDir, STEP);
    writeFileSync(loopAreaFile(repoDir, 'armed-interrupt.yaml')!, body);
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    expectReasonShown(rig.view(), 'engine-input-missing');
  });

  it('(h): an `armed-interrupt.yaml` that exists but cannot be read halts a clean verdict gate and runs no approve (N9b.5(b))', async () => {
    const rig = makeRig();
    startTrusted(rig);
    armInterrupt(repoDir, STEP);
    const arm = loopAreaFile(repoDir, 'armed-interrupt.yaml')!;
    rmSync(arm);
    mkdirSync(arm);
    await reachGate(rig, 'clean', 'verdict');
    expect(rig.approvals).toEqual([]);
    expectReasonShown(rig.view(), 'engine-input-missing');
  });

  it('an unreadable `armed-interrupt.yaml` is reported as unreadable at consolidation, not as an arm; the clean gate that follows halts with (h), not (c)', async () => {
    const rig = makeRig();
    startTrusted(rig);
    armInterrupt(repoDir, STEP);
    writeFileSync(loopAreaFile(repoDir, 'armed-interrupt.yaml')!, 'step: [unclosed\n');
    expect(rig.gate.interruptArmed(repoDir, STEP)).toBe('unreadable');
    await reachGate(rig, 'clean');
    const letters = rig.view().autoGate?.haltReasons.map((r) => r.reason) ?? [];
    expect(letters).toContain('engine-input-missing');
    expect(letters).not.toContain('interrupt-armed');
  });

  it('negative pair: a readable arm hands back at consolidation', () => {
    const rig = makeRig();
    startTrusted(rig);
    armInterrupt(repoDir, STEP);
    expect(rig.gate.interruptArmed(repoDir, STEP)).toBe('set');
  });

  it('a consume that cannot clear `armed-interrupt.yaml` is shown on the (c) halt (N9b.6(c))', async () => {
    const rig = makeRig();
    startTrusted(rig);
    armInterrupt(repoDir, STEP);
    const arm = loopAreaFile(repoDir, 'armed-interrupt.yaml')!;
    rmSync(arm);
    mkdirSync(arm);
    await reachGate(rig, 'clean', 'interrupt');
    const c = rig.view().autoGate?.haltReasons.find((r) => r.reason === 'interrupt-armed');
    expect(c?.detail ?? '').toMatch(/could not be cleared/);
  });

  it('a consolidator consume that cannot clear `armed-interrupt.yaml` does not throw into the consolidation, and is surfaced', () => {
    const rig = makeRig();
    startTrusted(rig);
    armInterrupt(repoDir, STEP);
    const arm = loopAreaFile(repoDir, 'armed-interrupt.yaml')!;
    rmSync(arm);
    mkdirSync(arm);
    expect(() => rig.gate.consumeInterrupt(repoDir)).not.toThrow();
    expect(rig.errors.map((e) => e.reason).join('\n')).toMatch(/could not be cleared/);
  });

  describe('a human decision at the (c) gate retries a failed interrupt clear (N9b.6(c))', () => {
    const decideAt = (rig: Rig, lands = true): Promise<boolean> =>
      composeHumanDecisionRunners(rig.gate, { decide: async () => lands, advance: () => 'advanced', currentStep: () => STEP }).decide(repoDir, STEP, TURN, 'approve');

    it('negative pair: a human decision at a gate halted without (c) leaves an arm made there in place', async () => {
      const rig = makeRig();
      startTrusted(rig);
      await reachGate(rig, 'stop for a human');
      expect(rig.view().autoGate?.haltReasons.map((r) => r.reason)).not.toContain('interrupt-armed');
      armInterrupt(repoDir, STEP);
      await expect(decideAt(rig)).resolves.toBe(true);
      expect(existsSync(loopAreaFile(repoDir, 'armed-interrupt.yaml')!)).toBe(true);
    });

    it('negative pair: a human decision at a (c) gate whose clear succeeded leaves an arm made afterwards in place', async () => {
      const rig = makeRig();
      startTrusted(rig);
      armInterrupt(repoDir, STEP);
      await reachGate(rig, 'clean', 'interrupt');
      const c = rig.view().autoGate?.haltReasons.find((r) => r.reason === 'interrupt-armed');
      expect(c).toBeDefined();
      expect(c?.detail).toBeUndefined();
      armInterrupt(repoDir, STEP);
      await expect(decideAt(rig)).resolves.toBe(true);
      expect(existsSync(loopAreaFile(repoDir, 'armed-interrupt.yaml')!)).toBe(true);
    });

    it('negative pair: a human decision that did not land at the (c) gate leaves the arm in place', async () => {
      const rig = makeRig();
      const arm = await haltOnUnclearableArm(rig);
      rmSync(arm, { recursive: true });
      armInterrupt(repoDir, STEP);
      await expect(decideAt(rig, false)).resolves.toBe(false);
      expect(existsSync(arm)).toBe(true);
    });

    it('negative pair: a human decision landing at another step leaves an arm in place while the failed-clear (c) halt is still shown', async () => {
      const rig = makeRig();
      const arm = await haltOnUnclearableArm(rig);
      rmSync(arm, { recursive: true });
      armInterrupt(repoDir, STEP);
      const other = `${STEP}-other`;
      const runners = composeHumanDecisionRunners(rig.gate, { decide: async () => true, advance: () => 'advanced', currentStep: () => other });
      await expect(runners.decide(repoDir, other, TURN, 'approve')).resolves.toBe(true);
      expect(existsSync(arm)).toBe(true);
    });

    async function haltOnUnclearableArm(rig: Rig): Promise<string> {
      startTrusted(rig);
      armInterrupt(repoDir, STEP);
      const arm = loopAreaFile(repoDir, 'armed-interrupt.yaml')!;
      rmSync(arm);
      mkdirSync(arm);
      await reachGate(rig, 'clean', 'interrupt');
      expect(rig.view().autoGate?.haltReasons.find((r) => r.reason === 'interrupt-armed')?.detail ?? '').toMatch(/could not be cleared/);
      return arm;
    }

    it('a manual Advance at the (c) gate retries the clear: no arm left behind', async () => {
      const rig = makeRig();
      const arm = await haltOnUnclearableArm(rig);
      rmSync(arm, { recursive: true });
      armInterrupt(repoDir, STEP);
      const runners = composeHumanDecisionRunners(rig.gate, { decide: async () => true, advance: () => 'advanced', currentStep: () => STEP });
      expect(runners.advance(repoDir, STEP)).toBe('advanced');
      expect(existsSync(arm)).toBe(false);
    });

    it('a clear that now succeeds leaves no arm behind', async () => {
      const rig = makeRig();
      const arm = await haltOnUnclearableArm(rig);
      rmSync(arm, { recursive: true });
      armInterrupt(repoDir, STEP);
      await expect(decideAt(rig)).resolves.toBe(true);
      expect(existsSync(arm)).toBe(false);
    });

    it('a clear that still fails is surfaced', async () => {
      const rig = makeRig();
      await haltOnUnclearableArm(rig);
      expect(rig.errors.map((e) => e.reason).join('\n')).not.toMatch(/could not be cleared/);
      await decideAt(rig);
      expect(rig.errors.map((e) => e.reason).join('\n')).toMatch(/could not be cleared/);
    });
  });

});

describe('autoGate — every engine approve outcome other than `advanced` halts the gate (N9b.6(k)/(l), #137 S1)', () => {
  it.each([
    ['refused', { kind: 'refused', reason: 'the run-state no longer matches the gate' } as GateApproveOutcome, 1, 'approve-not-persisted', 'the run-state no longer matches the gate'],
    ['accept-failed', { kind: 'accept-failed', reason: 'ENOSPC' } as GateApproveOutcome, 0, 'approve-not-persisted', 'ENOSPC'],
    ['blocked', { kind: 'blocked' } as GateApproveOutcome, 1, 'epic-promotion', undefined],
    ['preview-raised', { kind: 'preview-raised' } as GateApproveOutcome, 0, 'epic-promotion', undefined],
    ['abandoned', { kind: 'abandoned' } as GateApproveOutcome, 1, 'approve-not-persisted', 'the engine approve did not settle within its bound'],
  ] as const)('%s: human-needed, no longer deciding, its letter and reason shown, no failed-effect marker, and only the `auto-halt` entries the controller owns', async (_label, outcome, entries, letter, detail) => {
    const rig = makeRig();
    startTrusted(rig);
    rig.outcome(outcome);
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate?.deciding).toBe(false);
    expect(v.autoGate?.failedEffect).toBeUndefined();
    expect(v.autoGate?.haltReasons).toEqual([detail === undefined ? { reason: letter } : { reason: letter, detail }]);
    expect(autoHalts(rig)).toHaveLength(entries);
  });

  it('a clean `auto` gate with no engine approve attached: human-needed with (l) naming it, one `auto-halt` entry, and no approve', async () => {
    const rig = makeRig({ approveAttached: false });
    startTrusted(rig);
    await reachGate(rig, 'clean');
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate?.haltReasons).toEqual([{ reason: 'approve-not-persisted', detail: 'engine approve not wired' }]);
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['approve-not-persisted']]);
    expect(rig.approvals).toEqual([]);
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
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['approve-not-persisted']]);
  });

  it.each(['onto the next loop step', 'off the gate\'s step'] as const)('an engine approve that rejects after the flow moved %s: the failed-effect marker set and no `auto-halt` entry', async (move) => {
    let pending = true;
    const rig = makeRig({ runInProgress: () => pending });
    startTrusted(rig);
    rig.gate.attachApprove(async (dir, _step, _turnKey, decider) => {
      if (decider.kind === 'engine') decider.claimAccept();
      pending = false;
      if (move === 'onto the next loop step') rig.gate.beginLoopRun(dir, 'next');
      throw new Error('advance threw after the accept');
    });
    await reachGate(rig, 'clean');
    expect(rig.view().autoGate?.failedEffect?.state).toBe('set');
    expect(autoHalts(rig)).toEqual([]);
  });

  it('an engine approve that rejects when the gate\'s step cannot be read counts the gate as pending: one `auto-halt` entry naming (l)', async () => {
    let readable = true;
    const rig = makeRig({
      runInProgress: () => {
        if (!readable) throw new Error('flow state unreadable');
        return true;
      },
    });
    startTrusted(rig);
    rig.gate.attachApprove(async (_dir, _step, _turnKey, decider) => {
      if (decider.kind === 'engine') decider.claimAccept();
      readable = false;
      throw new Error('advance threw after the accept');
    });
    await reachGate(rig, 'clean');
    expect(rig.view().humanNeeded).toBe(true);
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['approve-not-persisted']]);
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
    expect(v.autoGate?.haltReasons.map((r) => r.reason)).toContain('interrupt-armed');
    expect(autoHalts(rig).flatMap((c) => parseAutoHaltReasons(c) ?? [])).toContain('interrupt-armed');
  });

  it('an interrupt arm that becomes unreadable after the evaluation but before the claim is refused at the claim: no accept, human-needed, (h) shown and recorded', async () => {
    const rig = makeRig();
    startTrusted(rig);
    const release = rig.hold();
    await reachGate(rig, 'clean');
    armInterrupt(repoDir, STEP);
    writeFileSync(loopAreaFile(repoDir, 'armed-interrupt.yaml')!, 'step: [unclosed\n');
    release();
    await flush();
    expect(readAppLoopState(repoDir)?.status).toBe('complete');
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate?.haltReasons.map((r) => r.reason)).toContain('engine-input-missing');
    expect(autoHalts(rig).flatMap((c) => parseAutoHaltReasons(c) ?? [])).toContain('engine-input-missing');
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
    expect(v.autoGate?.deciding).toBe(false);
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

// Plan AC14 row (S3): the bound is the operator's `APP_AUTO_GATE_DECISION_MS`, read through the one runtime-config
// parser; a non-finite or non-positive value falls back to the default.
describe('autoGate — the decision bound is the operator setting (AC14, N9b.5(e), #137 S3)', () => {
  const CONFIGURED_MS = 1500;

  async function heldUnclaimed(env: NodeJS.ProcessEnv): Promise<Rig> {
    const rig = makeRig({ env });
    startTrusted(rig);
    rig.hold();
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
    return rig;
  }

  it('a held engine approve reads human-needed exactly at the configured bound, not before it: one alert, and (l) shown', async () => {
    const rig = await heldUnclaimed({ APP_AUTO_GATE_DECISION_MS: String(CONFIGURED_MS) });
    rig.clock.advanceBy(CONFIGURED_MS - 1);
    expect(rig.view().humanNeeded).toBe(false);
    expect(rig.notify).not.toHaveBeenCalled();
    rig.clock.advanceBy(1);
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate?.haltReasons.map((r) => r.reason)).toEqual(['approve-not-persisted']);
    expect(rig.notify).toHaveBeenCalledTimes(1);
  });

  // Plan S4 "The claim": an approve not yet claimed at the bound gives `abandoned`, so its late claim never accepts.
  it('a held engine approve released after the bound finds its claim abandoned: the run-state stays `complete`, and no further entry or alert follows', async () => {
    const rig = makeRig({ env: { APP_AUTO_GATE_DECISION_MS: String(CONFIGURED_MS) } });
    startTrusted(rig);
    const release = rig.hold();
    await reachGate(rig, 'clean');
    rig.clock.advanceBy(CONFIGURED_MS);
    expect(rig.view().autoGate?.haltReasons.map((r) => r.reason)).toEqual(['approve-not-persisted']);
    expect(autoHalts(rig)).toHaveLength(1);
    const entries = rig.audits.length;
    release();
    await flush();
    expect(readAppLoopState(repoDir)?.status).toBe('complete');
    expect(rig.audits).toHaveLength(entries);
    expect(rig.notify).toHaveBeenCalledTimes(1);
    expect(rig.view().humanNeeded).toBe(true);
  });

  it('an engine approve that hangs after its claim is marked hung at the configured bound, with the failed-effect marker set', async () => {
    const rig = makeRig({ env: { APP_AUTO_GATE_DECISION_MS: String(CONFIGURED_MS) } });
    startTrusted(rig);
    rig.gate.attachApprove(async (dir, step, turnKey, decider) => {
      rig.approvals.push({ repoDir: dir, step, turnKey, decider: decider.kind });
      if (decider.kind === 'engine') decider.claimAccept();
      writeAppLoopState(dir, { loop: LOOP, step, turnKey, status: 'accepted' }, FIXED);
      await new Promise<void>(() => {});
      return { kind: 'advanced', effectFailures: [] };
    });
    await reachGate(rig, 'clean');
    rig.clock.advanceBy(CONFIGURED_MS - 1);
    expect(rig.view().autoGate?.hung).toBe(false);
    expect(rig.notify).not.toHaveBeenCalled();
    rig.clock.advanceBy(1);
    const v = rig.view();
    expect(v.autoGate?.hung).toBe(true);
    expect(v.autoGate?.failedEffect?.state).toBe('set');
    expect(v.humanNeeded).toBe(true);
    expect(rig.notify).toHaveBeenCalledTimes(1);
  });

  it.each(['-5', '0', 'NaN', 'abc'])('a configured bound of %j falls back to the default: not human-needed at default − 1 ms, human-needed at the default', async (raw) => {
    const rig = await heldUnclaimed({ APP_AUTO_GATE_DECISION_MS: raw });
    rig.clock.advanceBy(AUTO_GATE_DECISION_DEFAULT_MS - 1);
    expect(rig.view().humanNeeded).toBe(false);
    expect(rig.notify).not.toHaveBeenCalled();
    rig.clock.advanceBy(1);
    expect(rig.view().humanNeeded).toBe(true);
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

  it.each([
    ['an accepted failed turn', 'accepted', 'acceptedFailure'],
    ['a failed turn', 'error', 'endedInError'],
  ] as const)('%s is persisted before the (b) halt that shows it is pushed (N9b.5(d))', (_label, event, flag) => {
    const seen: (boolean | null)[] = [];
    const rig = makeRig({
      onPush: (dir) => {
        const r = readGateRunState(dir);
        seen.push(r.kind === 'ok' ? (r.state.loopRun?.[flag] ?? null) : null);
      },
    });
    startTrusted(rig);
    writeAppLoopState(repoDir, { loop: LOOP, step: STEP, turnKey: TURN, status: 'error', errorReason: 'turn stalled' }, FIXED);
    seen.length = 0;
    rig.gate.loopRunEvent(repoDir, STEP, TURN, event);
    expectReasonShown(rig.view(), 'loop-error');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((v) => v === true)).toBe(true);
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
    ['a `needs a human` round report (a)', 'needs-a-human', { roundReport: roundReportWithDisposition(['summary'], ['p1'], 'needs a human') }],
    ['an accepted failed review round (b)', 'loop-error', 'accepted'],
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
    expectReasonShown(rig.view(), letter);
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
    resolveDef: () => ({ ok: true, def: COMMIT_GATE, tierRoot: '/tmp/tier', defDir: '/tmp/tier/loop' }),
    refs: () => ({ pr: null, ticket: null, bootstrap: null }),
    runSideEffect: async () => {},
    runCommitSideEffect: async () => ({ outcome: 'committed', sha: SHA, branch: 'main' }),
    recordBaseline: () => {},
    persistAccept: () => {},
    assembleReport: () => {},
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
      emitError: () => {},
      setTimer: (cb, ms) => clock.setTimer(cb, ms),
      clearTimer: (h) => clock.clearTimer(h),
      decisionBoundMs: resolveRuntimeConfig({}).autoGateDecisionMs,
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

  // #137 S4, plan row 10 "Step-scoped advance": the manual Advance arrives through the human runner after the claim.
  it('a manual Advance through the human runner, landing after the engine approve\'s claim, ends one step further, entered once', async () => {
    const wt = fx.makeWorktree('engine-step-scoped-claimed');
    fx.writeFlowHome(wt, { name: 'scoped', stepIds: [STEP, 'next', 'after'] });
    const entered: string[] = [];
    const flow = createFlowManager({ globalDir: fx.outsideDir('engine-step-scoped-claimed-global'), onEnterStep: (step) => void entered.push(step.id) });
    expect(flow.start(wt).stepName).toBe(STEP);
    entered.length = 0;
    plantDef(COMMIT_DEF_YAML);
    defNow = plantedResolution(wt);
    const rig = makeRig();
    const runners = composeHumanDecisionRunners(rig.gate, {
      decide: async () => true,
      advance: (dir) => flow.advance(dir),
      currentStep: (dir) => flow.state(dir).stepName,
    });
    rig.gate.attachApprove(
      composeEngineApprove(
        () =>
          plantedApproveDeps({
            runCommitSideEffect: async () => {
              runners.advance(wt, STEP);
              return { outcome: 'committed', sha: SHA, branch: 'main' };
            },
            advanceFlow: stepScopedAdvance((repoDir) => flow.state(repoDir).stepName, (repoDir) => void flow.advance(repoDir)),
          }),
        () => 'app',
      ),
    );
    startTrusted(rig, loopSteps('auto'), wt);
    await reachGate(rig, 'clean', 'verdict', wt);
    await vi.waitFor(() => expect(entered).toEqual(['next']), { timeout: 5000 });
    await flush();
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
    expect(v.autoGate?.deciding).toBe(false);
    expectReasonShown(v, 'approve-not-persisted');
  });

  // Plan AC13 row (S4 (l)), through the real `runAppApprove`.
  it('a `persistAccept` that throws: (l) naming the failure, one engine-marked `accept-failed` entry, and no second attempt once timers advance', async () => {
    defNow = plantedResolution(repoDir);
    const rig = makeRig();
    const approveEntries: string[] = [];
    let attempts = 0;
    rig.gate.attachApprove(
      composeEngineApprove(
        () =>
          plantedApproveDeps({
            audit: (_dir, cmd) => void approveEntries.push(cmd),
            persistAccept: () => {
              attempts += 1;
              throw new Error('ENOSPC: no space left on device');
            },
          }),
        () => 'app',
      ),
    );
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(rig.view().autoGate?.haltReasons).toEqual([{ reason: 'approve-not-persisted', detail: expect.stringContaining('ENOSPC') }]);
    const acceptFailed = approveEntries.filter((c) => gateDecisionKind(c)?.kind === 'accept-failed');
    expect(acceptFailed.map((c) => gateDecisionDecider(c))).toEqual(['engine']);
    const entries = rig.audits.length;
    rig.clock.advanceBy(AUTO_GATE_DECISION_DEFAULT_MS + 1);
    rig.pushView(repoDir);
    rig.pushView(repoDir);
    await flush();
    expect(attempts).toBe(1);
    expect(rig.audits).toHaveLength(entries);
    expect(rig.view().humanNeeded).toBe(true);
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
    expectReasonShown(rig.view(), 'loop-error');
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['loop-error']]);

    writeAppLoopState(repoDir, { loop: LOOP, step: STEP, turnKey: TURN, status: 'complete', round: 1 }, FIXED);
    rig.gate.loopRunEvent(repoDir, STEP, TURN, 'accepted');
    await flush();
    expectReasonShown(rig.view(), 'loop-error');
    expect(autoHalts(rig)).toHaveLength(1);
  });

  it('a Retry out of the error stop clears (b): the turn back at work shows no halt reason', async () => {
    const rig = makeRig();
    startTrusted(rig);
    writeAppLoopState(repoDir, { loop: LOOP, step: STEP, turnKey: TURN, status: 'error', errorReason: 'turn stalled' }, FIXED);
    rig.gate.loopRunEvent(repoDir, STEP, TURN, 'error');
    await flush();
    expectReasonShown(rig.view(), 'loop-error');
    writeAppLoopState(repoDir, { loop: LOOP, step: STEP, turnKey: TURN, status: 'working', round: 1 }, FIXED);
    rig.gate.loopRunEvent(repoDir, STEP, TURN, 'retried');
    await flush();
    expect(rig.view().autoGate?.haltReasons ?? []).toEqual([]);
  });
});

describe('autoGate — the failed-effect marker across gates of either authority (AC13, N9b.5(d), #137 S2)', () => {
  const decisions: { repoKey: string; step: string; turnKey: string; option: string }[] = [];
  const advanced: string[] = [];
  let currentStep: string | null = STEP;
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
    expect(autoHalts(rig).flatMap((c) => parseAutoHaltReasons(c) ?? [])).not.toContain('failed-effect');
  });

  // N9b.5(d): the clearing decision may be at an `auto` gate the marker halted with (i), not only at a `human` one.
  it('a human decision at an `auto` gate halted with (i), through the composed runners, clears the marker: the next `auto` gate is engine-approved', async () => {
    const rig = makeRig();
    const runners = runnersFor(rig);
    const steps: FlowStepDef[] = [STEPS_MARKER[0], STEPS_MARKER[2], { id: 'fourth', kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' }, STEPS_MARKER[3]];
    await markerSet(rig, steps);
    await enterAndReach(rig, 'third');
    expectReasonShown(rig.view(), 'failed-effect');
    expect(rig.approvals.map((a) => a.step)).toEqual([STEP]);
    await expect(runners.decide(repoDir, 'third', TURN, 'approve')).resolves.toBe(true);
    expect(rig.view().autoGate?.failedEffect).toBeUndefined();

    await enterAndReach(rig, 'fourth');
    expect(rig.approvals.map((a) => a.step)).toEqual([STEP, 'fourth']);
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['failed-effect']]);
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

  it('a manual Advance naming no step, through the composed runners, advances the current step and clears the marker its gate showed (§27.15)', async () => {
    const rig = makeRig();
    const runners = runnersFor(rig);
    await markerSet(rig);
    await enterAndReach(rig, 'human-step');
    currentStep = 'human-step';
    expect(runners.advance(repoDir, undefined)).toBe(`advanced:${repoDir}`);
    expect(advanced).toEqual([repoDir]);
    expect(rig.view().autoGate?.failedEffect).toBeUndefined();
  });

  it('a manual Advance naming no step, with no current step, is refused and advances nothing', async () => {
    const rig = makeRig();
    const runners = runnersFor(rig);
    currentStep = null;
    expect(runners.advance(repoDir, undefined)).toBeNull();
    expect(advanced).toEqual([]);
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
    expectReasonShown(v, 'failed-effect');
    expect(rig.approvals.map((a) => a.step)).toEqual([STEP]);
  });

  // N9b.5(d): a manual step shows no gate, so advancing out of it is not a decision at a gate that showed the marker.
  it('a manual Advance out of a manual step, through the composed runners, keeps the marker: the next `auto` gate halts with (i)', async () => {
    const rig = makeRig();
    const runners = runnersFor(rig);
    const steps: FlowStepDef[] = [STEPS_MARKER[0], { id: 'manual-mid', kind: 'manual' }, STEPS_MARKER[2], STEPS_MARKER[3]];
    await markerSet(rig, steps);
    currentStep = 'manual-mid';
    expect(runners.advance(repoDir, 'manual-mid')).toBe(`advanced:${repoDir}`);
    expect(rig.view().autoGate?.failedEffect?.state).toBe('set');

    await enterAndReach(rig, 'third');
    expectReasonShown(rig.view(), 'failed-effect');
    expect(rig.approvals.map((a) => a.step)).toEqual([STEP]);
  });
});

describe('autoGate — a human decision at the run\'s last loop gate clears the marker before the run end (N9b.5(d), #137 S2)', () => {
  const STEPS_LAST: FlowStepDef[] = [STEPS_MARKER[0], STEPS_MARKER[1], { id: 'finalize', kind: 'manual' }];

  function runnersThatAdvance(rig: Rig): ReturnType<typeof composeHumanDecisionRunners<string>> {
    const record = composeRecordFlowTransition({ recordTransition: () => {} }, rig.gate);
    const toFinalize = (): void => record(repoDir, 'advance', flowAt(STEPS_LAST, 'human-step'), flowAt(STEPS_LAST, 'finalize'));
    return composeHumanDecisionRunners(rig.gate, {
      decide: async () => {
        toFinalize();
        return true;
      },
      advance: (repoKey: string) => {
        toFinalize();
        return `advanced:${repoKey}`;
      },
      currentStep: () => 'human-step',
    });
  }

  it('a human approve that advances onto the final manual step emits no run-end failure and writes no (i) entry', async () => {
    const rig = makeRig();
    await markerSet(rig, STEPS_LAST);
    await enterAndReach(rig, 'human-step');
    await runnersThatAdvance(rig).decide(repoDir, 'human-step', TURN, 'approve');
    expect(rig.errors).toEqual([]);
    expect(autoHalts(rig)).toEqual([]);
    expect(rig.view().autoGate?.failedEffect).toBeUndefined();
  });

  it('a manual Advance at that gate onto the final manual step emits no run-end failure and writes no (i) entry', async () => {
    const rig = makeRig();
    await markerSet(rig, STEPS_LAST);
    await enterAndReach(rig, 'human-step');
    runnersThatAdvance(rig).advance(repoDir, 'human-step');
    expect(rig.errors).toEqual([]);
    expect(autoHalts(rig)).toEqual([]);
  });

  it('negative pair: a decision that does not land leaves the marker to the run end, which emits it once and writes one (i) entry', async () => {
    const rig = makeRig();
    await markerSet(rig, STEPS_LAST);
    await enterAndReach(rig, 'human-step');
    const record = composeRecordFlowTransition({ recordTransition: () => {} }, rig.gate);
    const runners = composeHumanDecisionRunners(rig.gate, {
      decide: async () => {
        record(repoDir, 'advance', flowAt(STEPS_LAST, 'human-step'), flowAt(STEPS_LAST, 'finalize'));
        return false;
      },
      advance: (repoKey: string) => repoKey,
      currentStep: () => 'human-step',
    });
    await runners.decide(repoDir, 'human-step', TURN, 'approve');
    expect(rig.errors).toHaveLength(1);
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['failed-effect']]);
  });

  it.each(['decide', 'advance'] as const)('a human %s that throws after the advance onto the final step still reports the marker at the run end: one error and one (i) entry', async (which) => {
    const rig = makeRig();
    await markerSet(rig, STEPS_LAST);
    await enterAndReach(rig, 'human-step');
    const record = composeRecordFlowTransition({ recordTransition: () => {} }, rig.gate);
    const toFinalize = (): void => record(repoDir, 'advance', flowAt(STEPS_LAST, 'human-step'), flowAt(STEPS_LAST, 'finalize'));
    const runners = composeHumanDecisionRunners(rig.gate, {
      decide: async () => {
        toFinalize();
        throw new Error('decision threw');
      },
      advance: () => {
        toFinalize();
        throw new Error('advance threw');
      },
      currentStep: () => 'human-step',
    });
    if (which === 'decide') await expect(runners.decide(repoDir, 'human-step', TURN, 'approve')).rejects.toThrow('decision threw');
    else expect(() => runners.advance(repoDir, 'human-step')).toThrow('advance threw');
    expect(rig.errors).toHaveLength(1);
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['failed-effect']]);
  });
});

describe('autoGate — one decider per gate, through the composed runners (AC10, N9b.5(e), #137)', () => {
  it.each([true, false])('a human decision attempt (landed: %s) that reaches the gate before the engine approve stands the engine down: no engine approve and no engine entry', async (landed) => {
    const rig = makeRig();
    const runners = composeHumanDecisionRunners(rig.gate, {
      decide: async () => landed,
      advance: (repoKey: string) => repoKey,
      currentStep: () => STEP,
    });
    startTrusted(rig);
    rig.gate.gateReaching(repoDir, STEP, TURN, 'clean', 'verdict');
    writeAppLoopState(repoDir, { loop: LOOP, step: STEP, turnKey: TURN, status: 'complete', round: 1, verdict: 'clean' }, FIXED);
    const attempt = runners.decide(repoDir, STEP, TURN, 'request-changes', 'note');
    rig.gate.gateReached(repoDir, STEP, TURN);
    await attempt;
    await flush();
    expect(rig.approvals).toEqual([]);
    expect(engineDecided(rig)).toEqual([]);
    expect(rig.view().autoGate?.deciding).toBe(false);
  });
});

describe('autoGate — a manual Advance at the deciding gate stands the engine down (AC10, N9b.5(e))', () => {
  it('a manual Advance that reaches the gate before the engine approve stands the engine down: no engine approve and no engine entry', async () => {
    const rig = makeRig();
    const runners = composeHumanDecisionRunners(rig.gate, {
      decide: async () => true,
      advance: (repoKey: string) => repoKey,
      currentStep: () => STEP,
    });
    startTrusted(rig);
    rig.gate.gateReaching(repoDir, STEP, TURN, 'clean', 'verdict');
    writeAppLoopState(repoDir, { loop: LOOP, step: STEP, turnKey: TURN, status: 'complete', round: 1, verdict: 'clean' }, FIXED);
    expect(runners.advance(repoDir, STEP)).toBe(repoDir);
    rig.gate.gateReached(repoDir, STEP, TURN);
    await flush();
    expect(rig.approvals).toEqual([]);
    expect(engineDecided(rig)).toEqual([]);
  });
});

describe('autoGate — a human decision that settles after a new Start leaves the new run alone (N9b.5(d))', () => {
  it('the earlier run\'s landed decision does not overwrite the new run\'s persisted gate state', async () => {
    const rig = makeRig();
    await markerSet(rig);
    let release!: (landed: boolean) => void;
    const runners = composeHumanDecisionRunners(rig.gate, {
      decide: () => new Promise<boolean>((r) => (release = r)),
      advance: (repoKey: string) => repoKey,
      currentStep: () => STEP,
    });
    const attempt = runners.decide(repoDir, STEP, TURN, 'approve', '');

    const newStart = Date.parse('2026-07-17T13:00:00.000Z');
    current = startRun(STEPS_MARKER);
    rig.gate.bindAtStart(repoDir, current, newStart);
    rig.gate.commitStart(repoDir);
    rig.gate.beginLoopRun(repoDir, STEP);
    release(true);
    await attempt;
    await flush();
    const persisted = readGateRunState(repoDir);
    expect(persisted.kind === 'ok' ? persisted.state.run.startedAt : persisted.kind).toBe(newStart);
  });
});

describe('autoGate — only an attempt at the deciding gate stands the engine down (N9b.5(e))', () => {
  it.each([
    ['another step', 'other-step', TURN],
    ['another turn of the same step', STEP, 'consolidate-earlier'],
  ])('a refused decision naming %s does not stand the engine down: the clean gate is engine-approved', async (_label, step, turnKey) => {
    const rig = makeRig();
    const runners = composeHumanDecisionRunners(rig.gate, {
      decide: async () => false,
      advance: (repoKey: string) => repoKey,
      currentStep: () => STEP,
    });
    startTrusted(rig);
    rig.gate.gateReaching(repoDir, STEP, TURN, 'clean', 'verdict');
    writeAppLoopState(repoDir, { loop: LOOP, step: STEP, turnKey: TURN, status: 'complete', round: 1, verdict: 'clean' }, FIXED);
    const attempt = runners.decide(repoDir, step, turnKey, 'request-changes', 'note');
    rig.gate.gateReached(repoDir, STEP, TURN);
    await attempt;
    await flush();
    expect(rig.approvals.map((a) => a.step)).toEqual([STEP]);
  });
});

describe('autoGate — a gate-state write that cannot land is surfaced and fails closed (N9b.5(b)/(d))', () => {
  function blockGateState(dir: string): string {
    const file = loopAreaFile(dir, 'gate-run.yaml')!;
    mkdirSync(join(file, 'blocker'), { recursive: true });
    return file;
  }

  it('the failure is emitted as an error and the next clean `auto` gate halts with (h): no engine approve', async () => {
    const rig = makeRig();
    blockGateState(repoDir);
    startTrusted(rig);
    expect(rig.errors.length).toBeGreaterThan(0);
    expect(rig.errors[0].reason).toContain('gate state');
    await reachGate(rig, 'clean');
    expect(rig.approvals).toEqual([]);
    expectReasonShown(rig.view(), 'engine-input-missing');
    expect(rig.view().autoGate?.haltReasons.find((r) => r.reason === 'engine-input-missing')?.detail).toBe('the run\'s gate state could not be saved');
  });

  it('once a later write lands, the next clean `auto` gate is engine-approved again (recovery pair)', async () => {
    const rig = makeRig();
    const file = blockGateState(repoDir);
    startTrusted(rig);
    rmSync(file, { recursive: true, force: true });
    rig.gate.beginLoopRun(repoDir, STEP);
    await reachGate(rig, 'clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
    expect(autoHalts(rig)).toEqual([]);
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
    expect(halts.map((c) => ({ reasons: parseAutoHaltReasons(c), decider: gateDecisionDecider(c) }))).toEqual([{ reasons: ['failed-effect'], decider: 'engine' }]);

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
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['failed-effect']]);
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
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['failed-effect']]);
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

// §27.9.1 N9b.7 — #137 S4: the engine's own frozen check at the approve, run with real git against the phase
// baseline. A held check is held by a `git` shim first on PATH that waits, while a hold file exists, on any
// invocation naming the baseline (the e2e's FAKE_GIT_HOLD_REV, at the integration boundary).
describe('autoGate — the approve-time frozen check (AC12, N9b.7, #137 S4)', { timeout: 30_000 }, () => {
  const FROZEN = 'tests/frozen.test.ts';
  let fixture: ReturnType<typeof createGitRepoFixture>;
  let baseline: string;
  let disposers: (() => void)[];
  const scratch = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    disposers.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  beforeEach(() => {
    fixture = createGitRepoFixture();
    repoDir = fixture.makeGitRepo('autogate-frozen');
    fixture.writeRepoFile(repoDir, '.gitignore', '.agent-terminal/\n');
    writeLoopCapabilities(repoDir, { testGlobs: ['tests/**'] });
    fixture.writeRepoFile(repoDir, FROZEN, 'test("frozen", () => {});\n');
    fixture.writeRepoFile(repoDir, 'src/a.ts', 'export const a = 1;\n');
    baseline = fixture.commitAll(repoDir, 'RED');
    recordBaselineCommit(repoDir, 'main', baseline);
    defNow = { ...OPERATOR_DEF, completion: 'green' };
    disposers = [];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dispose of disposers.splice(0)) dispose();
    fixture.cleanup();
  });

  const editSource = (): void => fixture.writeRepoFile(repoDir, 'src/a.ts', 'export const a = 2;\n');
  const editFrozenTest = (): void => fixture.writeRepoFile(repoDir, FROZEN, 'test("frozen", () => { expect(1).toBe(2); });\n');
  const letters = (rig: Rig): AutoHaltReason[] => rig.view().autoGate?.haltReasons.map((r) => r.reason) ?? [];
  const engineApprovals = (rig: Rig): Approval[] => rig.approvals.filter((a) => a.decider === 'engine');

  /** Waits until the gate is no longer being decided (the check, and any approve it led to, settled). */
  const settled = async (rig: Rig): Promise<void> => {
    await vi.waitFor(() => expect(rig.view().autoGate?.deciding).toBe(false), { timeout: 10_000, interval: 20 });
    await flush();
  };

  /** Holds every git invocation naming the baseline while the hold file exists, logging `held <argv>` first. Every
   *  invocation logs `start <pid>`, and `end <pid>` on an exit its trap sees; an invocation whose pid is gone counts
   *  as ended whatever signal stopped it. */
  function holdBaselineReads(match: string = baseline): { log: string; release: () => void; entered: () => Promise<boolean>; drained: () => Promise<void>; endedWhileHeld: () => Promise<boolean> } {
    const dir = scratch('autogate-hold-');
    const log = join(dir, 'git.log');
    const hold = join(dir, 'hold');
    writeFileSync(hold, '');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    disposers.push(
      installPathGitStub([
        {
          argvPrefix: [],
          script:
            `printf 'start %s\\n' "$$" >> ${shellQuote(log)}; trap "printf 'end %s\\n' $$ >> ${shellQuote(log)}" EXIT; trap 'exit 143' TERM INT; ` +
            `for a in "$@"; do case "$a" in *${match}*) printf 'held %s\\n' "$*" >> ${shellQuote(log)}; ` +
            `end=$((SECONDS + 20)); while [ -e ${shellQuote(hold)} ] && [ "$SECONDS" -lt "$end" ]; do sleep 0.02; done; break;; esac; done; ` +
            `${shellQuote(realGit)} "$@"; exit $?`,
        },
      ]).dispose,
    );
    const pids = (word: 'start' | 'end'): string[] =>
      (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : []).flatMap((l) => new RegExp(`^${word} (\\d+)$`).exec(l)?.[1] ?? []);
    const alive = (pid: string): boolean => {
      try {
        process.kill(Number(pid), 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM';
      }
    };
    const inFlight = (): number => {
      const ended = new Set(pids('end'));
      return pids('start').filter((p) => !ended.has(p) && alive(p)).length;
    };
    return {
      log,
      release: () => rmSync(hold, { force: true }),
      // Settled once no git is in flight and no new one started across five consecutive polls, so a check's follow-up
      // read (spawned after the held one returns) and the result handling after it are both waited out.
      drained: async () => {
        let started = -1;
        let quiet = 0;
        for (let i = 0; i < 200 && quiet < 5; i += 1) {
          const balanced = inFlight() === 0;
          quiet = balanced && pids('start').length === started ? quiet + 1 : 0;
          started = balanced ? pids('start').length : -1;
          await new Promise((r) => setTimeout(r, 50));
          await flush();
        }
      },
      endedWhileHeld: async () => {
        for (let i = 0; i < 250; i += 1) {
          if (!existsSync(hold)) return false;
          if (pids('start').length > 0 && inFlight() === 0) return true;
          await new Promise((r) => setTimeout(r, 20));
        }
        return false;
      },
      entered: async () => {
        for (let i = 0; i < 500; i += 1) {
          if (existsSync(log) && readFileSync(log, 'utf8').includes(match)) return true;
          await new Promise((r) => setTimeout(r, 20));
        }
        return false;
      },
    };
  }

  it.each(['green', 'refactor'] as const)('a clean %s gate whose round changed no test is approved by the engine, and the flag is recorded with no paths', async (completion) => {
    defNow = { ...OPERATOR_DEF, completion };
    const rig = makeRig();
    startTrusted(rig);
    editSource();
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(autoHalts(rig)).toEqual([]);
    expect(engineApprovals(rig).map((a) => a.step)).toEqual([STEP]);
    expect(readChangedTests(repoDir)).toEqual({ step: STEP, paths: [] });
  });

  it.each(['green', 'refactor'] as const)('(d): a clean %s gate whose round edited a committed test halts, records the flag naming it, and runs no approve', async (completion) => {
    defNow = { ...OPERATOR_DEF, completion };
    const rig = makeRig();
    startTrusted(rig);
    editFrozenTest();
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(engineApprovals(rig)).toEqual([]);
    expect(letters(rig)).toEqual(['frozen-tests-changed']);
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['frozen-tests-changed']]);
    expect(rig.view().humanNeeded).toBe(true);
    expect(readChangedTests(repoDir)).toEqual({ step: STEP, paths: [FROZEN] });
  });

  it('(d): a new untracked test file is a detection', async () => {
    const rig = makeRig();
    startTrusted(rig);
    fixture.writeRepoFile(repoDir, 'tests/added.test.ts', 'test("added", () => {});\n');
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(letters(rig)).toEqual(['frozen-tests-changed']);
    expect(readChangedTests(repoDir)?.paths).toEqual(['tests/added.test.ts']);
  });

  it('(d): a `changed-tests.yaml` already holding `paths: []` is not read as the result', async () => {
    recordChangedTests(repoDir, STEP, []);
    const rig = makeRig();
    startTrusted(rig);
    editFrozenTest();
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(engineApprovals(rig)).toEqual([]);
    expect(letters(rig)).toEqual(['frozen-tests-changed']);
    expect(readChangedTests(repoDir)?.paths).toEqual([FROZEN]);
  });

  it('the working tree\'s `test_globs` are the ones read: globs narrowed to exclude an edited test leave it undetected, and the gate is approved', async () => {
    writeLoopCapabilities(repoDir, { testGlobs: ['spec/**'] });
    const rig = makeRig();
    startTrusted(rig);
    editFrozenTest();
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(autoHalts(rig)).toEqual([]);
    expect(engineApprovals(rig).map((a) => a.step)).toEqual([STEP]);
  });

  it('(e): `loop-capabilities.yaml` missing from the working tree halts with a detail naming it, and leaves the last recorded flag in place', async () => {
    recordChangedTests(repoDir, 'earlier-step', ['tests/earlier.test.ts']);
    const flagBefore = readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8');
    fixture.removeRepoFile(repoDir, 'loop-capabilities.yaml');
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(engineApprovals(rig)).toEqual([]);
    const rows = rig.view().autoGate?.haltReasons ?? [];
    expect(rows.map((r) => r.reason)).toEqual(['frozen-check-unavailable']);
    expect(rows[0]?.detail ?? '').toMatch(/loop-capabilities\.yaml/);
    expect(readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8')).toBe(flagBefore);
  });

  it.each([
    ['a symlink', (dir: string) => {
      fixture.writeRepoFile(dir, 'caps-target.yaml', 'test_globs: [tests/**]\ntest_command: x\nbuild_command: y\n');
      rmSync(join(dir, 'loop-capabilities.yaml'));
      symlinkSync(join(dir, 'caps-target.yaml'), join(dir, 'loop-capabilities.yaml'));
    }],
    ['oversize', (dir: string) => fixture.writeRepoFile(dir, 'loop-capabilities.yaml', `test_globs: [tests/**]\n#${'x'.repeat(MAX_CAPABILITIES_BYTES)}\n`)],
    ['malformed', (dir: string) => fixture.writeRepoFile(dir, 'loop-capabilities.yaml', 'test_globs: [unclosed\n')],
  ] as const)('(e): a working-tree `loop-capabilities.yaml` that is %s halts with a detail naming it, and leaves the last recorded flag in place', async (_label, plant) => {
    recordChangedTests(repoDir, 'earlier-step', ['tests/earlier.test.ts']);
    const flagBefore = readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8');
    plant(repoDir);
    editSource();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(engineApprovals(rig)).toEqual([]);
    const rows = rig.view().autoGate?.haltReasons ?? [];
    expect(rows.map((r) => r.reason)).toEqual(['frozen-check-unavailable']);
    expect(rows[0]?.detail ?? '').toMatch(/loop-capabilities\.yaml/);
    expect(readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8')).toBe(flagBefore);
  });

  it.each([
    ['no baseline', (): void => clearBaselineCommit(repoDir)],
    ['a `baseline-commit.yaml` that cannot be read', (): void => writeFileSync(loopAreaFile(repoDir, 'baseline-commit.yaml')!, 'sha: [unclosed\n')],
    ['a baseline recorded on another branch', (): void => void recordBaselineCommit(repoDir, 'another-branch', baseline)],
    ['a detached HEAD', (): void => void fixture.git(repoDir, ['checkout', '-q', '--detach'])],
  ] as const)('(e): %s halts with a detail naming the baseline, and leaves the last recorded flag in place', async (_label, plant) => {
    recordChangedTests(repoDir, 'earlier-step', ['tests/earlier.test.ts']);
    const flagBefore = readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8');
    plant();
    editSource();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(engineApprovals(rig)).toEqual([]);
    const rows = rig.view().autoGate?.haltReasons ?? [];
    expect(rows.map((r) => r.reason)).toEqual(['frozen-check-unavailable']);
    expect(rows[0]?.detail ?? '').toMatch(/baseline/i);
    expect(readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8')).toBe(flagBefore);
  });

  it('(e): a git failure (a baseline naming no object in the repo) halts with a detail, and leaves the last recorded flag in place', async () => {
    recordChangedTests(repoDir, 'earlier-step', ['tests/earlier.test.ts']);
    const flagBefore = readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8');
    recordBaselineCommit(repoDir, 'main', 'b'.repeat(40));
    editSource();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(engineApprovals(rig)).toEqual([]);
    const rows = rig.view().autoGate?.haltReasons ?? [];
    expect(rows.map((r) => r.reason)).toEqual(['frozen-check-unavailable']);
    expect(rows[0]?.detail ?? '').toMatch(/git|baseline/i);
    expect(readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8')).toBe(flagBefore);
  });

  it('(e): a flag that cannot be written halts with a detail naming it', async () => {
    mkdirSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, { recursive: true });
    editSource();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(engineApprovals(rig)).toEqual([]);
    const rows = rig.view().autoGate?.haltReasons ?? [];
    expect(rows.map((r) => r.reason)).toEqual(['frozen-check-unavailable']);
    expect(rows[0]?.detail ?? '').toMatch(/changed-tests/);
  });

  it('(d) and (e): a changed test whose flag cannot be written still halts naming the change and its path', async () => {
    mkdirSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, { recursive: true });
    editFrozenTest();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(engineApprovals(rig)).toEqual([]);
    expect([...letters(rig)].sort()).toEqual(['frozen-check-unavailable', 'frozen-tests-changed']);
    expect([...autoHalts(rig).flatMap((c) => parseAutoHaltReasons(c))].sort()).toEqual(['frozen-check-unavailable', 'frozen-tests-changed']);
    const rows = rig.view().autoGate?.haltReasons ?? [];
    expect(rows.map((r) => r.detail ?? '').join('\n')).toContain(FROZEN);
  });

  it.each([
    ['could not be resolved', {}, (): void => void (defNow = null)],
    ['threw', { defThrows: (): boolean => true }, (): void => {}],
  ] as const)('an `auto` step whose def %s at the gate is still frozen-checked: a changed test halts with (d) (N9b.7(c))', async (_label, rigOpts, plant) => {
    editFrozenTest();
    plant();
    const rig = makeRig(rigOpts);
    startTrusted(rig);
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(engineApprovals(rig)).toEqual([]);
    expect(letters(rig)).toContain('frozen-tests-changed');
    expect(readChangedTests(repoDir)?.paths).toEqual([FROZEN]);
  });

  it('a `red`-completion step with a changed test path runs no check: approved, no (d), no flag written', async () => {
    defNow = { ...OPERATOR_DEF, completion: 'red' };
    editFrozenTest();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(autoHalts(rig)).toEqual([]);
    expect(engineApprovals(rig).map((a) => a.step)).toEqual([STEP]);
    expect(readChangedTests(repoDir)).toBeNull();
  });

  it('an `auto` step with no completion (groom) and a stale `baseline-commit.yaml` runs no check and is approved', async () => {
    defNow = OPERATOR_DEF;
    recordBaselineCommit(repoDir, 'main', 'b'.repeat(40));
    editFrozenTest();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(autoHalts(rig)).toEqual([]);
    expect(engineApprovals(rig).map((a) => a.step)).toEqual([STEP]);
  });

  it('every git read of the check carries GIT_OPTIONAL_LOCKS=0', async () => {
    const log = join(scratch('autogate-locks-'), 'git.log');
    const stub = installPathGitStub([{ argvPrefix: [], script: `printf '%s %s\\n' "\${GIT_OPTIONAL_LOCKS:-unset}" "\${sub[0]}" >> ${shellQuote(log)}` }]);
    disposers.push(stub.dispose);
    vi.stubEnv('GIT_OPTIONAL_LOCKS', '1');
    editSource();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    await settled(rig);
    const lines =(existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((l) => !l.startsWith('0 '))).toEqual([]);
  });

  it('every git read of the check runs under the repo\'s own git config: no hooks-path or fsmonitor override (v2.184 (10))', async () => {
    const log = join(scratch('autogate-config-'), 'git.log');
    const stub = installPathGitStub([{ argvPrefix: [], script: `printf '%s\\n' "$*" >> ${shellQuote(log)}` }]);
    disposers.push(stub.dispose);
    editSource();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    await settled(rig);
    const lines = (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter((l) => l.length > 0);
    expect(lines.some((l) => l.includes('rev-parse --abbrev-ref HEAD'))).toBe(true);
    expect(lines.filter((l) => /core\.(hooksPath|fsmonitor)=/.test(l))).toEqual([]);
  });

  it('the real check, held on the baseline: a `held` line naming it is logged before the gate settles, and releasing the hold lets it settle', async () => {
    const held = holdBaselineReads();
    editSource();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(await held.entered(), 'the approve-time frozen check reads git at the baseline').toBe(true);
    expect(readFileSync(held.log, 'utf8')).toContain(baseline);
    expect(rig.view().autoGate?.deciding).toBe(true);
    expect(rig.view().humanNeeded).toBe(false);
    held.release();
    await settled(rig);
    expect(engineApprovals(rig).map((a) => a.step)).toEqual([STEP]);
  });

  it.each([
    ['unreadable', () => writeFileSync(loopAreaFile(repoDir, 'run-state.yaml')!, ': not [yaml\n')],
    ['absent', () => rmSync(loopAreaFile(repoDir, 'run-state.yaml')!, { force: true })],
  ] as const)('a run-state that turns %s during the held check has not left the gate: the result still decides it', async (_name, spoil) => {
    const held = holdBaselineReads();
    editSource();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(await held.entered(), 'the approve-time frozen check reads git at the baseline').toBe(true);
    spoil();
    held.release();
    await held.drained();
    expect(engineApprovals(rig).length + autoHalts(rig).length, 'the engine decided the gate rather than standing down').toBeGreaterThan(0);
  });

  // AC10 — human first wins: the engine stands down for every human channel landing during the held check.
  describe('a human decision landing during the held check wins (AC10, N9b.5(e))', () => {
    const humanRunners = (rig: Rig, landed: boolean, decided: GateDecisionOption[] = []) =>
      composeHumanDecisionRunners(rig.gate, {
        decide: async (_dir, _step, _turnKey, option) => {
          decided.push(option);
          return landed;
        },
        advance: () => 'advanced' as const,
        currentStep: () => STEP,
      });

    it.each([
      ['approve', true],
      ['request-changes', true],
      ['redo', true],
      ['back-to-red', true],
      ['approve', false],
      ['request-changes', false],
      ['redo', false],
      ['back-to-red', false],
    ] as [GateDecisionOption, boolean][])('%s (landed: %s): after release, no engine-decided entry, no engine approve, and the earlier flag is untouched', async (option, landed) => {
      recordChangedTests(repoDir, 'earlier-step', ['tests/earlier.test.ts']);
      const flagBefore = readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8');
      const held = holdBaselineReads();
      editFrozenTest();
      const rig = makeRig();
      startTrusted(rig);
      await reachGate(rig, 'clean');
      expect(await held.entered(), 'the approve-time frozen check reads git at the baseline').toBe(true);
      const decided: GateDecisionOption[] = [];
      await humanRunners(rig, landed, decided).decide(repoDir, STEP, TURN, option, undefined);
      expect(await held.endedWhileHeld(), 'the human attempt aborts the in-flight git read').toBe(true);
      held.release();
      await settled(rig);
      await held.drained();
      expect(decided).toEqual([option]);
      expect(engineDecided(rig)).toEqual([]);
      expect(engineApprovals(rig)).toEqual([]);
      expect(rig.view().autoGate?.haltReasons ?? []).toEqual([]);
      rig.pushView(repoDir);
      rig.pushView(repoDir);
      await flush();
      expect(autoHalts(rig)).toEqual([]);
      expect(readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8')).toBe(flagBefore);
    });

    it('a manual Advance: after release, no engine-decided entry, no engine approve, and the earlier flag is untouched', async () => {
      recordChangedTests(repoDir, 'earlier-step', ['tests/earlier.test.ts']);
      const flagBefore = readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8');
      const held = holdBaselineReads();
      editSource();
      const rig = makeRig();
      startTrusted(rig);
      await reachGate(rig, 'clean');
      expect(await held.entered(), 'the approve-time frozen check reads git at the baseline').toBe(true);
      expect(humanRunners(rig, true).advance(repoDir, STEP)).toBe('advanced');
      expect(await held.endedWhileHeld(), 'the human attempt aborts the in-flight git read').toBe(true);
      held.release();
      await settled(rig);
      await held.drained();
      expect(engineDecided(rig)).toEqual([]);
      expect(engineApprovals(rig)).toEqual([]);
      expect(readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8')).toBe(flagBefore);
    });

    it('a dropped request-changes: the gate reads human-needed, the notifier raises once, no `auto-halt` entry exists even after the bound fires, and the earlier flag is untouched', async () => {
      recordChangedTests(repoDir, 'earlier-step', ['tests/earlier.test.ts']);
      const flagBefore = readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8');
      const held = holdBaselineReads();
      editFrozenTest();
      const rig = makeRig();
      startTrusted(rig);
      await reachGate(rig, 'clean');
      expect(await held.entered(), 'the approve-time frozen check reads git at the baseline').toBe(true);
      await humanRunners(rig, false).decide(repoDir, STEP, TURN, 'request-changes', undefined);
      expect(await held.endedWhileHeld(), 'the human attempt aborts the in-flight git read').toBe(true);
      held.release();
      await settled(rig);
      await held.drained();
      expect(rig.view().humanNeeded).toBe(true);
      expect(rig.notify).toHaveBeenCalledTimes(1);
      rig.clock.advanceBy(AUTO_GATE_DECISION_DEFAULT_MS + 1);
      expect(autoHalts(rig)).toEqual([]);
      expect(engineDecided(rig)).toEqual([]);
      expect(rig.notify).toHaveBeenCalledTimes(1);
      expect(readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8')).toBe(flagBefore);
    });

    it.each([true, false])('the bound firing after a human attempt (landed: %s) but before the aborted check settles writes no engine-decided entry', async (landed) => {
      const held = holdBaselineReads();
      editFrozenTest();
      const rig = makeRig();
      startTrusted(rig);
      await reachGate(rig, 'clean');
      expect(await held.entered(), 'the approve-time frozen check reads git at the baseline').toBe(true);
      await humanRunners(rig, landed).decide(repoDir, STEP, TURN, 'approve', undefined);
      rig.clock.advanceBy(AUTO_GATE_DECISION_DEFAULT_MS + 1);
      held.release();
      await settled(rig);
      await held.drained();
      expect(autoHalts(rig)).toEqual([]);
      expect(engineDecided(rig)).toEqual([]);
      expect(rig.view().autoGate?.haltReasons ?? []).toEqual([]);
    });
  });

  // Plan row "Policy re-checked at the claim" (N9b.5(c)).
  it('an interrupt armed during the held check is refused at the claim: (c) and (l) in one entry, no accept, and the arm consumed', async () => {
    const held = holdBaselineReads();
    editSource();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(await held.entered(), 'the approve-time frozen check reads git at the baseline').toBe(true);
    armInterrupt(repoDir, STEP);
    held.release();
    await settled(rig);
    expect(readAppLoopState(repoDir)?.status).toBe('complete');
    expect([...letters(rig)].sort()).toEqual(['approve-not-persisted', 'interrupt-armed']);
    expect(autoHalts(rig).map((c) => [...(parseAutoHaltReasons(c) ?? [])].sort())).toEqual([['approve-not-persisted', 'interrupt-armed']]);
    expect(readArmedInterrupt(repoDir)).toBeNull();
  });

  it('Terminate during the held check: no accept, no flag written, no engine-decided entry and no halt shown', async () => {
    const held = holdBaselineReads();
    editFrozenTest();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(await held.entered(), 'the approve-time frozen check reads git at the baseline').toBe(true);
    rig.gate.endRun(repoDir);
    expect(await held.endedWhileHeld(), 'Terminate aborts the in-flight git read').toBe(true);
    held.release();
    await held.drained();
    expect(readAppLoopState(repoDir)?.status).toBe('complete');
    expect(rig.approvals).toEqual([]);
    expect(engineDecided(rig)).toEqual([]);
    expect(autoHalts(rig)).toEqual([]);
    expect(readChangedTests(repoDir)).toBeNull();
  });

  it('the run-state leaving the gate during the held check: after release, the earlier flag is untouched, and no halt, engine-decided entry or engine approve exists', async () => {
    recordChangedTests(repoDir, 'earlier-step', ['tests/earlier.test.ts']);
    const flagBefore = readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8');
    const held = holdBaselineReads();
    editFrozenTest();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(await held.entered(), 'the approve-time frozen check reads git at the baseline').toBe(true);
    writeAppLoopState(repoDir, { loop: LOOP, step: 'next', turnKey: 'work-next', status: 'working' }, FIXED);
    rig.pushView(repoDir);
    expect(await held.endedWhileHeld(), 'the gate left aborts the in-flight git read').toBe(true);
    held.release();
    await held.drained();
    expect(readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8')).toBe(flagBefore);
    expect(autoHalts(rig)).toEqual([]);
    expect(engineDecided(rig)).toEqual([]);
    expect(engineApprovals(rig)).toEqual([]);
  });

  it('the run-state leaving the gate during the held check with no view pulled: after release, the earlier flag is untouched, and no halt or engine-decided entry exists', async () => {
    recordChangedTests(repoDir, 'earlier-step', ['tests/earlier.test.ts']);
    const flagBefore = readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8');
    const held = holdBaselineReads();
    editFrozenTest();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(await held.entered(), 'the approve-time frozen check reads git at the baseline').toBe(true);
    writeAppLoopState(repoDir, { loop: LOOP, step: 'next', turnKey: 'work-next', status: 'working' }, FIXED);
    held.release();
    await held.drained();
    await flush();
    expect(readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8')).toBe(flagBefore);
    expect(autoHalts(rig)).toEqual([]);
    expect(engineDecided(rig)).toEqual([]);
    expect(engineApprovals(rig)).toEqual([]);
  });

  it('the run-state leaving the gate during the held check with no view pulled, then the bound firing: no halt, engine-decided entry or engine approve exists', async () => {
    recordChangedTests(repoDir, 'earlier-step', ['tests/earlier.test.ts']);
    const flagBefore = readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8');
    const held = holdBaselineReads();
    editFrozenTest();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(await held.entered(), 'the approve-time frozen check reads git at the baseline').toBe(true);
    writeAppLoopState(repoDir, { loop: LOOP, step: 'next', turnKey: 'work-next', status: 'working' }, FIXED);
    rig.clock.advanceBy(AUTO_GATE_DECISION_DEFAULT_MS);
    expect(await held.endedWhileHeld(), 'the bound aborts the in-flight git read').toBe(true);
    held.release();
    await held.drained();
    await flush();
    expect(autoHalts(rig)).toEqual([]);
    expect(engineDecided(rig)).toEqual([]);
    expect(engineApprovals(rig)).toEqual([]);
    expect(readFileSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, 'utf8')).toBe(flagBefore);
  });

  it('(e): a branch read that fails halts with a detail naming the failed read, not a missing baseline', async () => {
    disposers.push(installPathGitStub([{ argvPrefix: ['rev-parse', '--abbrev-ref', 'HEAD'], stderr: 'fatal: scripted branch failure\n', exitCode: 128 }]).dispose);
    editSource();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(engineApprovals(rig)).toEqual([]);
    const rows = rig.view().autoGate?.haltReasons ?? [];
    expect(rows.map((r) => r.reason)).toEqual(['frozen-check-unavailable']);
    expect(rows[0]?.detail ?? '').not.toMatch(/no phase baseline/);
    expect(rows[0]?.detail ?? '').toMatch(/branch could not be read/);
  });

  it('an interrupt armed before the gate survives a clean check: halts with (c) alone, no engine approve, and the arm consumed', async () => {
    editSource();
    armInterrupt(repoDir, STEP);
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(engineApprovals(rig)).toEqual([]);
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['interrupt-armed']]);
    expect(readArmedInterrupt(repoDir)).toBeNull();
  });

  it('an interrupt armed before the gate survives a detection: (c) and (d) in one entry, no engine approve', async () => {
    editFrozenTest();
    armInterrupt(repoDir, STEP);
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(engineApprovals(rig)).toEqual([]);
    expect(autoHalts(rig).map((c) => [...(parseAutoHaltReasons(c) ?? [])].sort())).toEqual([['frozen-tests-changed', 'interrupt-armed']]);
    expect(readArmedInterrupt(repoDir)).toBeNull();
  });

  it('an interrupt armed before the gate survives a flag that cannot be written: (c) and (e) in one entry, and the arm consumed', async () => {
    mkdirSync(loopAreaFile(repoDir, 'changed-tests.yaml')!, { recursive: true });
    editSource();
    armInterrupt(repoDir, STEP);
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(engineApprovals(rig)).toEqual([]);
    expect(autoHalts(rig).map((c) => [...(parseAutoHaltReasons(c) ?? [])].sort())).toEqual([['frozen-check-unavailable', 'interrupt-armed']]);
    expect(readArmedInterrupt(repoDir)).toBeNull();
  });

  // Plan row "Baseline as persisted" (N9b.7(c)): a RED approve that persists no baseline leaves GREEN's check unable to run.
  it.each([
    ['a detached-HEAD RED approve', (): void => {
      fixture.git(repoDir, ['checkout', '-q', '--detach']);
    }],
    ['a RED approve whose baseline write fails', (): void => {
      mkdirSync(loopAreaFile(repoDir, 'baseline-commit.yaml')!, { recursive: true });
    }],
  ] as const)('%s, through the real approve deps: the clean `auto` GREEN gate halts with (e), and HEAD is unchanged', async (_label, plant) => {
    clearBaselineCommit(repoDir);
    plant();
    plantDef(COMMIT_DEF_YAML);
    const steps: FlowStepDef[] = [
      { id: 'red', kind: 'loop', loop: LOOP, loopNamespace: 'app', gateAuthority: 'auto' },
      { id: STEP, kind: 'loop', loop: 'green-loop', loopNamespace: 'app', gateAuthority: 'auto' },
      { id: 'next', kind: 'manual' },
    ];
    const rig = makeRig({ defFor: (loop) => ({ ...OPERATOR_DEF, completion: loop === LOOP ? 'red' : 'green' }) });
    rig.gate.attachApprove(
      composeEngineApprove(() => plantedApproveDeps({ runCommitSideEffect: createRealAppGateCommit(repoDir), recordBaseline: recordBaselineCommit }), () => 'app'),
    );
    startTrusted(rig, steps);
    const before = fixture.git(repoDir, ['rev-parse', 'HEAD']);
    fixture.writeRepoFile(repoDir, 'tests/red.test.ts', 'test("red", () => { expect(1).toBe(2); });\n');
    await reachGate(rig, 'clean', 'verdict', repoDir, 'red');
    await vi.waitFor(() => expect(fixture.git(repoDir, ['rev-parse', 'HEAD'])).not.toBe(before), { timeout: 10_000 });
    await settled(rig);
    const redCommit = fixture.git(repoDir, ['rev-parse', 'HEAD']);
    expect(readBaselineCommit(repoDir)).toBeNull();

    rig.gate.beginLoopRun(repoDir, STEP);
    editSource();
    await reachGate(rig, 'clean');
    await settled(rig);
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c) ?? [])).toEqual([expect.arrayContaining(['frozen-check-unavailable'])]);
    expect(rig.view().autoGate?.haltReasons?.find((r) => r.reason === 'frozen-check-unavailable')?.detail ?? '').toMatch(/baseline/i);
    expect(rig.view().humanNeeded).toBe(true);
    expect(fixture.git(repoDir, ['rev-parse', 'HEAD'])).toBe(redCommit);
  });

  // AC14 [S4] — the bound aborts an unsettled frozen check and halts with (e); its later result is discarded.
  it('a held check is not human-needed at bound − 1 ms; at the bound it halts with (e), and its later result writes no flag and no second entry', async () => {
    const held = holdBaselineReads();
    editFrozenTest();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(await held.entered(), 'the approve-time frozen check reads git at the baseline').toBe(true);
    rig.clock.advanceBy(AUTO_GATE_DECISION_DEFAULT_MS - 1);
    expect(rig.view().humanNeeded).toBe(false);
    expect(rig.notify).not.toHaveBeenCalled();
    rig.clock.advanceBy(1);
    expect(rig.view().humanNeeded).toBe(true);
    expect(letters(rig)).toEqual(['frozen-check-unavailable']);
    expect(rig.notify).toHaveBeenCalledTimes(1);
    expect(await held.endedWhileHeld(), 'the bound aborts the in-flight git read').toBe(true);
    held.release();
    await held.drained();
    expect(autoHalts(rig).map((c) => parseAutoHaltReasons(c))).toEqual([['frozen-check-unavailable']]);
    expect(readChangedTests(repoDir)).toBeNull();
    expect(engineApprovals(rig)).toEqual([]);
  });

  it('a check held on its branch read leaves the gate deciding without blocking main; at the bound it halts with (e) and the read is aborted', async () => {
    const held = holdBaselineReads('--abbrev-ref');
    editSource();
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(await held.entered(), 'the approve-time frozen check reads the current branch').toBe(true);
    expect(readFileSync(held.log, 'utf8'), 'the held branch read is still in flight, not waited out on main').not.toMatch(/^end /m);
    expect(rig.view().autoGate?.deciding).toBe(true);
    rig.clock.advanceBy(AUTO_GATE_DECISION_DEFAULT_MS);
    expect(letters(rig)).toEqual(['frozen-check-unavailable']);
    expect(rig.view().humanNeeded).toBe(true);
    expect(await held.endedWhileHeld(), 'the bound aborts the in-flight branch read').toBe(true);
    held.release();
    await held.drained();
    expect(engineApprovals(rig)).toEqual([]);
    expect(readChangedTests(repoDir)).toBeNull();
  });

  it('a held check reaching the bound over an interrupt armed before the gate halts with (c) and (e) in one entry, and the arm is consumed', async () => {
    const held = holdBaselineReads();
    editSource();
    armInterrupt(repoDir, STEP);
    const rig = makeRig();
    startTrusted(rig);
    await reachGate(rig, 'clean');
    expect(await held.entered(), 'the approve-time frozen check reads git at the baseline').toBe(true);
    rig.clock.advanceBy(AUTO_GATE_DECISION_DEFAULT_MS);
    expect([...letters(rig)].sort()).toEqual(['frozen-check-unavailable', 'interrupt-armed']);
    expect(autoHalts(rig).map((c) => [...(parseAutoHaltReasons(c) ?? [])].sort())).toEqual([['frozen-check-unavailable', 'interrupt-armed']]);
    expect(readArmedInterrupt(repoDir)).toBeNull();
    held.release();
    await held.drained();
  });
});
