import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAutoGate, type AutoGate, type DefResolution, type StartRun } from '../../src/main/autoGate';
import {
  composeCurrentRun,
  composeEngineApprove,
  composeLifecycleEndRun,
  composeLoopBindingResolve,
  composeObservedResolveDef,
  composeRecordFlowTransition,
  composeRunInProgressAt,
  composeStartTransition,
} from '../../src/main/autoGateComposition';
import { catalogEntryDefFile, createFlowManager, flowHomeDir, FLOW_DEF_FILE, type FlowManager } from '../../src/main/flow';
import { createRunResolver } from '../../src/main/runResolver';
import type { DispositionRead } from '../../src/main/resolveRunDefinition';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { createFlowStateStore } from '../../src/main/flowState';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { auditFilePath } from '../../src/main/auditPaths';
import { createFlowLifecycle, type FlowLifecycle } from '../../src/main/flowLifecycle';
import { createWorktreeLock } from '../../src/main/worktreeLock';
import { createHeldRunRecovery } from '../../src/main/heldRunRecovery';
import { createPendingNotices } from '../../src/main/pendingNotices';
import { provideAppLoopView } from '../../src/main/loopViewV2';
import { resolveLoopDefV2, type LoopDefV2Tiers } from '../../src/main/loopDefV2';
import { readAppLoopState, writeAppLoopState } from '../../src/main/appLoopState';
import { stepScopedAdvance, type AppGateDecisionDeps, type ApproveDecider } from '../../src/main/appGateDecision';
import { gateDecisionDecider, gateDecisionKind, parseAuditStream } from '../../src/shared/audit';
import type { ConsolidatorVerdict } from '../../src/shared/consolidatorOutput';
import type { FlowLoopView, FlowStateView } from '../../src/shared/ipc';
import { createGitRepoFixture } from '../helpers/gitRepo';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { productionRecoveryDeps } from '../helpers/heldRunRecoveryDeps';
import { createVirtualClock } from '../helpers/virtualClock';

// §27.9.1 N9b.2, N9b.5(b), N9b.8 — #137 plan rows "Terminate ends the engine-held run", "Restart and Undo
// keep authority", "Bind before entry", authority read from the run's bound flow, and a relaunch keeping it, driven through the production Start composition over the real flow manager, run resolver, flow
// lifecycle, §25 recorder and git.

const LOOP = 'plan-loop';
const STEP = 'plan';
const TURN = `consolidate-${STEP}`;
const FLOW_ID = 'auto-flow';
const FLOW_NAME = 'Auto Flow';
const T0 = Date.parse('2026-07-17T12:00:00.000Z');
const FIXED = (): Date => new Date(T0);

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

const flowYaml = (name: string, authority?: 'auto' | 'human'): string =>
  [
    `name: ${JSON.stringify(name)}`,
    'steps:',
    `  - id: ${STEP}`,
    '    kind: loop',
    `    loop: ${LOOP}`,
    '    loop_namespace: app',
    ...(authority ? [`    gate_authority: ${authority}`] : []),
    '  - id: next',
    '    kind: manual',
    '',
  ].join('\n');

const git = createGitRepoFixture();
const fx = createWorktreeFixture();
const scratch: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  git.cleanup();
  fx.cleanup();
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
};

function writeGlobalEntry(globalDir: string, id: string, yaml: string): void {
  const file = catalogEntryDefFile(globalDir, id);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, yaml);
}

function committedRepo(prefix: string): string {
  const wt = git.makeGitRepo(prefix);
  git.writeRepoFile(wt, 'README.md', 'baseline\n');
  git.commitAll(wt, 'baseline');
  mkdirSync(flowHomeDir(wt), { recursive: true });
  return wt;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};

interface Approval {
  step: string;
  decider: ApproveDecider['kind'];
}

interface RigOpts {
  wt?: string;
  pointer?: string | null;
  authority?: 'auto' | 'human';
  startClock?: () => number;
  start?: (flow: FlowManager) => FlowManager['start'];
  /** The app relaunched over this rig's worktree, catalog and §25 root: every in-memory part is new. */
  relaunchOf?: Rig;
  approveThrows?: () => boolean;
}

interface Rig {
  wt: string;
  globalDir: string;
  auditRoot: string;
  gate: AutoGate;
  flow: FlowManager;
  lifecycle: FlowLifecycle;
  flowStart: (repoKey: string) => FlowStateView;
  approvals: Approval[];
  resolvedAtStart: () => StartRun | undefined;
  view: () => FlowLoopView;
  persisted: () => ReturnType<ReturnType<typeof createFlowStateStore>['read']>;
  reachGate: (verdict: ConsolidatorVerdict) => Promise<void>;
  gateEntries: (startedAt: number, flow?: string) => string[] | null;
  relaunch: () => Rig;
}

function makeRig(opts: RigOpts = {}): Rig {
  const appDir = tempDir('autogate-life-app-');
  const defDir = join(appDir, 'loops-v2', LOOP);
  mkdirSync(join(defDir, 'prompts'), { recursive: true });
  writeFileSync(join(defDir, 'prompts', 'work.md'), 'do work\n');
  writeFileSync(join(defDir, 'prompts', 'consolidate.md'), 'judge\n');
  writeFileSync(join(defDir, `${LOOP}.yaml`), DEF_YAML);
  const tiers = (): LoopDefV2Tiers => ({ operator: null, appBundled: join(appDir, 'loops-v2'), retired: null });
  const ctxFor = (dir: string) => ({ tiers: tiers(), repoDir: dir });
  const plantedResolution = (dir: string): DefResolution | null => {
    const r = resolveLoopDefV2(LOOP, ctxFor(dir));
    return r.ok ? {} : null;
  };

  const prior = opts.relaunchOf;
  const wt = prior?.wt ?? opts.wt ?? committedRepo('autogate-life-wt');
  const globalDir = prior?.globalDir ?? fx.makeWorktree('autogate-life-global');
  if (prior === undefined) {
    writeGlobalEntry(globalDir, FLOW_ID, flowYaml(FLOW_NAME, opts.authority ?? 'auto'));
    if (opts.pointer !== null) writeActiveFlow(wt, opts.pointer ?? FLOW_ID);
  }
  const auditRoot = prior?.auditRoot ?? tempDir('autogate-life-audit-');

  const clock = createVirtualClock(0);
  const recorder = createAuditRecorder({ root: auditRoot, now: () => new Date(T0 + 1_000), flowName: () => null });
  const resolve = createRunResolver(globalDir);
  const held = new Map<string, StartRun>();
  const toRun = (r: { load: ReturnType<typeof resolve>['load']; binding?: DispositionRead }): StartRun | null =>
    r.load.ok ? { definition: r.load.definition, binding: r.binding } : null;

  const approvals: Approval[] = [];
  let flow!: FlowManager;
  const gate = createAutoGate({
    audit: (dir, cmd, exit) => recorder.recordCommand(dir, 'gate', cmd, exit),
    resolveDef: (dir) => plantedResolution(dir),
    currentRun: composeCurrentRun(globalDir),
    runInProgressAt: composeRunInProgressAt(),
    onViewChanged: () => {},
    setTimer: (cb, ms) => clock.setTimer(cb, ms),
    clearTimer: (h) => clock.clearTimer(h),
  });
  const preparerResolve = composeLoopBindingResolve(gate, composeObservedResolveDef(ctxFor));
  flow = createFlowManager({
    globalDir,
    loadDefinition: (repoKey) => resolve(repoKey),
    onEnterStep: (step) => {
      if (step.kind === 'loop') preparerResolve(wt, step.id, LOOP);
    },
  });
  const approveDepsFor = (): AppGateDecisionDeps => ({
    readRunState: (dir) => readAppLoopState(dir),
    resolveDef: (dir, name) => resolveLoopDefV2(name, ctxFor(dir)),
    refs: () => ({ pr: null, ticket: null, bootstrap: null }),
    runSideEffect: async () => {},
    runCommitSideEffect: async () => ({ outcome: 'committed', sha: 'a'.repeat(40), branch: 'main' }),
    recordBaseline: () => {},
    persistAccept: (dir, state) => writeAppLoopState(dir, state, FIXED),
    advanceFlow: stepScopedAdvance((dir) => flow.state(dir).stepName, (dir) => void flow.advance(dir)),
    audit: (dir, cmd, exit) => recorder.recordCommand(dir, 'gate', cmd, exit),
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
  });
  const engineApprove = composeEngineApprove(approveDepsFor, () => 'app');
  gate.attachApprove((dir, step, turnKey, decider) => {
    approvals.push({ step, decider: decider.kind });
    if (opts.approveThrows?.()) throw new Error('approve threw before settling');
    return engineApprove(dir, step, turnKey, decider);
  });

  const lockRoot = join(tempDir('autogate-life-locks-'), 'locks');
  const lock = createWorktreeLock({ lockRoot, holderLiveness: () => 'live-matching' });
  const lifecycle = createFlowLifecycle({
    lock,
    flow,
    recovery: createHeldRunRecovery({ lock, ...productionRecoveryDeps(globalDir) }),
    pendingNotices: createPendingNotices(),
    loopTurnActive: () => false,
    forgetRunEntry: () => {},
    endRun: composeLifecycleEndRun(gate),
    recordTerminate: (repoKey) => recorder.recordTerminate(repoKey),
    clearTodos: () => {},
    clearSliceBrief: () => {},
    clearMonitor: () => {},
    flowChanged: () => {},
    presentView: (_k, v) => v,
  });

  const start = opts.start ? opts.start(flow) : (k: string, o?: Parameters<FlowManager['start']>[1]) => flow.start(k, o);
  const flowStart = composeStartTransition({
    autoGate: gate,
    resolveForStart: (repoKey) => {
      const run = toRun(resolve(repoKey));
      if (!run) throw new Error('the flow did not resolve');
      held.set(repoKey, run);
      return run;
    },
    start: (repoKey, o) => start(repoKey, o),
    now: opts.startClock ?? (() => T0),
    record: composeRecordFlowTransition(recorder, gate),
  });

  const engineLike = { activeRepoDir: () => wt, resume: () => {}, liveErrorFor: () => null };
  const rig: Rig = {
    wt,
    globalDir,
    auditRoot,
    gate,
    flow,
    lifecycle,
    flowStart,
    approvals,
    resolvedAtStart: () => held.get(wt),
    view: () => provideAppLoopView(engineLike, LOOP, { tiers: tiers(), repoDir: wt }, gate.autoGateViewFor),
    persisted: () => createFlowStateStore(wt).read(),
    reachGate: async (verdict) => {
      gate.gateReaching(wt, STEP, TURN, verdict, 'verdict');
      writeAppLoopState(wt, { loop: LOOP, step: STEP, turnKey: TURN, status: 'complete', round: 1, verdict }, FIXED);
      gate.gateReached(wt, STEP, TURN);
      await flush();
    },
    gateEntries: (startedAt, flowName = FLOW_NAME) => {
      const file = auditFilePath(auditRoot, wt, flowName, new Date(startedAt));
      if (!existsSync(file)) return null;
      return parseAuditStream(readFileSync(file, 'utf8')).events.flatMap((e) => (e.type === 'command' && e.source === 'gate' ? [e.cmd] : []));
    },
    relaunch: () => makeRig({ relaunchOf: rig }),
  };
  return rig;
}

const engineEntries = (kind: string) => (cmds: string[] | null): string[] | null =>
  cmds === null ? null : cmds.filter((c) => gateDecisionKind(c)?.kind === kind && gateDecisionDecider(c) === 'engine');
const engineHalts = engineEntries('auto-halt');
const engineDecisions = engineEntries('decision');

/** The run reaches `done`: its `auto` gate is engine-approved onto `next`, which the operator advances. */
async function runToDone(rig: Rig, startedAt = T0): Promise<void> {
  expect(rig.flowStart(rig.wt).status).toBe('in_progress');
  await rig.reachGate('clean');
  expect(rig.approvals.map((a) => [a.step, a.decider])).toEqual([[STEP, 'engine']]);
  expect(engineDecisions(rig.gateEntries(startedAt))).toHaveLength(1);
  rig.flow.advance(rig.wt);
  expect(rig.flow.state(rig.wt).status).toBe('done');
}

function expectRunEnded(rig: Rig): void {
  expect(rig.gate.isAutoRun(rig.wt)).toBe(false);
  expect(rig.view()).not.toHaveProperty('autoGate');
  expect(rig.persisted()?.startedAt).toBeUndefined();
  expect(rig.persisted()?.flow).toBeUndefined();
}

describe('autoGate — Terminate ends the engine-held run through the flow lifecycle (#137 S1)', () => {
  it('Terminate of an in_progress `auto` run: the view carries no `autoGate` and flow-state no `started_at` or `flow`', async () => {
    const rig = makeRig();
    expect(rig.flowStart(rig.wt).status).toBe('in_progress');
    await rig.reachGate('stop for a human');
    expect(rig.view().autoGate?.haltReasons).toEqual([{ reason: 'stop-for-a-human' }]);

    expect(rig.lifecycle.terminate(rig.wt).outcome).toBe('reset');
    expectRunEnded(rig);
  });

  it('the claim-time run check reads flow-state: `in_progress` at the step only, never at another step, at `done`, or after a Terminate', () => {
    const rig = makeRig();
    const inProgressAt = composeRunInProgressAt();
    expect(rig.flowStart(rig.wt).status).toBe('in_progress');
    expect(inProgressAt(rig.wt, STEP)).toBe(true);
    expect(inProgressAt(rig.wt, 'next')).toBe(false);
    rig.flow.advance(rig.wt);
    expect(inProgressAt(rig.wt, STEP)).toBe(false);
    expect(inProgressAt(rig.wt, 'next')).toBe(true);
    rig.flow.advance(rig.wt);
    expect(rig.flow.state(rig.wt).status).toBe('done');
    expect(inProgressAt(rig.wt, 'next')).toBe(false);
    expect(rig.lifecycle.terminate(rig.wt).outcome).toBe('reset');
    expect(inProgressAt(rig.wt, STEP)).toBe(false);
  });

  it('Terminate of a `done` `auto` run ends it the same way', async () => {
    const rig = makeRig();
    await runToDone(rig);
    expect(rig.gate.isAutoRun(rig.wt)).toBe(true);

    expect(rig.lifecycle.terminate(rig.wt).outcome).toBe('reset');
    expectRunEnded(rig);
  });

  it('a first-step rollback to `not_started` ends it the same way', async () => {
    const rig = makeRig();
    expect(rig.flowStart(rig.wt).status).toBe('in_progress');
    await rig.reachGate('stop for a human');
    expect(rig.gate.isAutoRun(rig.wt)).toBe(true);

    expect(rig.lifecycle.rollbackStep(rig.wt, STEP).status).toBe('not_started');
    expectRunEnded(rig);
  });
});

describe('autoGate — Restart and Undo keep the Start-bound authority (#137 S1)', () => {
  it('Restart from `done` of a trusted `auto` run: its clean gate is engine-approved again, with no halt entry', async () => {
    const rig = makeRig();
    await runToDone(rig);

    rig.flow.restart(rig.wt);
    expect(rig.flow.state(rig.wt).stepName).toBe(STEP);
    await rig.reachGate('clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine', 'engine']);
    expect(rig.flow.state(rig.wt).stepName).toBe('next');
    expect(engineDecisions(rig.gateEntries(T0))).toHaveLength(2);
    expect(engineHalts(rig.gateEntries(T0))).toEqual([]);
  });

  it('Undo back onto the `auto` step: its clean gate is engine-approved again', async () => {
    const rig = makeRig();
    // Undo returns a `done` run to its last step (§24.2.2), so the `auto` step is the flow's last.
    writeGlobalEntry(rig.globalDir, FLOW_ID, flowYaml(FLOW_NAME, 'auto').replace('  - id: next\n    kind: manual\n', ''));
    expect(rig.flowStart(rig.wt).status).toBe('in_progress');
    await rig.reachGate('clean');
    expect(rig.flow.state(rig.wt).status).toBe('done');

    rig.flow.undo(rig.wt);
    expect(rig.flow.state(rig.wt).stepName).toBe(STEP);
    await rig.reachGate('clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine', 'engine']);
    expect(engineDecisions(rig.gateEntries(T0))).toHaveLength(2);
  });
});

describe('autoGate — bind before entry, through the Start composition (#137 S1)', () => {
  it('a flow whose first step is `auto` with a clean round advances through the engine approve, with no halt entry', async () => {
    const rig = makeRig();
    expect(rig.flowStart(rig.wt).status).toBe('in_progress');
    await rig.reachGate('clean');
    expect(rig.approvals.map((a) => [a.step, a.decider])).toEqual([[STEP, 'engine']]);
    expect(rig.flow.state(rig.wt).stepName).toBe('next');
    expect(engineDecisions(rig.gateEntries(T0))).toHaveLength(1);
    expect(engineHalts(rig.gateEntries(T0))).toEqual([]);
  });

  it('Start → done → Terminate → a new Start 1.5 s later: the new run\'s own §25 file has its first `auto` step\'s engine `decision` entry', async () => {
    let startedAt = T0;
    const rig = makeRig({ startClock: () => startedAt });
    await runToDone(rig);
    expect(rig.lifecycle.terminate(rig.wt).outcome).toBe('reset');

    startedAt = T0 + 1_500;
    expect(rig.flowStart(rig.wt).status).toBe('in_progress');
    await rig.reachGate('clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine', 'engine']);
    expect(engineDecisions(rig.gateEntries(T0 + 1_500))).toHaveLength(1);
    expect(engineDecisions(rig.gateEntries(T0))).toHaveLength(1);
  });

  it('(a) a `flow.start` that throws after the bind, with no prior run: no binding survives, and the next Start\'s clean `auto` gate advances once', async () => {
    let fail = true;
    const rig = makeRig({
      start: (flow) => (k, o) => {
        if (fail) throw new Error('flow.start failed');
        return flow.start(k, o);
      },
    });
    expect(() => rig.flowStart(rig.wt)).toThrow('flow.start failed');
    expect(rig.gate.isAutoRun(rig.wt)).toBe(false);
    writeAppLoopState(rig.wt, { loop: LOOP, step: STEP, turnKey: TURN, status: 'complete', round: 1, verdict: 'clean' }, FIXED);
    expect(rig.view()).not.toHaveProperty('autoGate');

    fail = false;
    expect(rig.flowStart(rig.wt).status).toBe('in_progress');
    await rig.reachGate('clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
    expect(engineDecisions(rig.gateEntries(T0))).toHaveLength(1);
  });

  it('(b) with a prior `done` trusted run, a Restart after a Start that throws still engine-approves its clean `auto` gate', async () => {
    let fail = false;
    const rig = makeRig({
      start: (flow) => (k, o) => {
        if (fail) throw new Error('flow.start failed');
        return flow.start(k, o);
      },
    });
    await runToDone(rig);

    fail = true;
    expect(() => rig.flowStart(rig.wt)).toThrow('flow.start failed');
    rig.flow.restart(rig.wt);
    await rig.reachGate('clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine', 'engine']);
    expect(engineDecisions(rig.gateEntries(T0))).toHaveLength(2);
    expect(engineHalts(rig.gateEntries(T0))).toEqual([]);
  });

  it('(c) a `flow.start` that refuses without throwing leaves no binding (negative; paired with the first-step advance above)', () => {
    const rig = makeRig({ start: (flow) => (k) => ({ ...flow.state(k), notice: 'The run could not be started: refused' }) });
    expect(rig.flowStart(rig.wt).status).toBe('not_started');
    expect(rig.gate.isAutoRun(rig.wt)).toBe(false);
    writeAppLoopState(rig.wt, { loop: LOOP, step: STEP, turnKey: TURN, status: 'complete', round: 1, verdict: 'clean' }, FIXED);
    expect(rig.view()).not.toHaveProperty('autoGate');
  });

});

describe('autoGate — authority read from the run\'s bound flow, over the real run resolver (N9b.2(c))', () => {
  it('the active-flow pointer moved to a worktree-local copy declaring `auto`: the run keeps its bound source and its clean gate advances', async () => {
    const rig = makeRig();
    expect(rig.flowStart(rig.wt).status).toBe('in_progress');
    const local = catalogEntryDefFile(rig.wt, 'local-copy');
    mkdirSync(dirname(local), { recursive: true });
    writeFileSync(local, flowYaml(FLOW_NAME, 'auto'));
    writeActiveFlow(rig.wt, 'local-copy');
    await rig.reachGate('clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
    expect(engineDecisions(rig.gateEntries(T0))).toHaveLength(1);
    expect(rig.view().autoGate?.haltGeneric ?? false).toBe(false);
  });

  it('a run bound through the leg-3 global fallback (pointer unset) advances its clean `auto` gate', async () => {
    const rig = makeRig({ pointer: null });
    writeFileSync(join(flowHomeDir(rig.globalDir), FLOW_DEF_FILE), flowYaml(FLOW_NAME, 'auto'));
    expect(rig.flowStart(rig.wt).status).toBe('in_progress');
    expect(rig.resolvedAtStart()?.binding).toEqual({ source: 'non-catalog' });
    await rig.reachGate('clean');
    expect(rig.approvals.map((a) => a.decider)).toEqual(['engine']);
    expect(engineDecisions(rig.gateEntries(T0))).toHaveLength(1);
  });

});

describe('autoGate — a relaunch keeps the run\'s authority (N9b.8)', () => {
  it('an `auto` run relaunched mid-loop: its clean gate after the relaunch is engine-approved, recorded in the run\'s own §25 file', async () => {
    const before = makeRig();
    expect(before.flowStart(before.wt).status).toBe('in_progress');

    const rig = before.relaunch();
    expect(rig.flow.state(rig.wt).stepName).toBe(STEP);
    expect(rig.gate.isAutoRun(rig.wt)).toBe(true);
    await rig.reachGate('clean');
    expect(rig.approvals.map((a) => [a.step, a.decider])).toEqual([[STEP, 'engine']]);
    expect(rig.flow.state(rig.wt).stepName).toBe('next');
    expect(engineDecisions(rig.gateEntries(T0))).toHaveLength(1);
    expect(engineHalts(rig.gateEntries(T0))).toEqual([]);
  });

  it('a `human` run relaunched mid-loop stays human: its clean gate waits with no engine state (negative pair)', async () => {
    const before = makeRig({ authority: 'human' });
    expect(before.flowStart(before.wt).status).toBe('in_progress');

    const rig = before.relaunch();
    expect(rig.gate.isAutoRun(rig.wt)).toBe(false);
    await rig.reachGate('clean');
    expect(rig.approvals).toEqual([]);
    expect(rig.view()).not.toHaveProperty('autoGate');
  });

  it('an `auto` gate reached clean before the relaunch, its engine approve never run, halts with (j) after it: no engine approve, and the letter is shown at the gate', async () => {
    const before = makeRig();
    expect(before.flowStart(before.wt).status).toBe('in_progress');
    writeAppLoopState(before.wt, { loop: LOOP, step: STEP, turnKey: TURN, status: 'complete', round: 1, verdict: 'clean' }, FIXED);

    const rig = before.relaunch();
    await flush();
    expect(rig.approvals).toEqual([]);
    const v = rig.view();
    expect(v.humanNeeded).toBe(true);
    expect(v.autoGate?.haltReasons.map((r) => r.reason) ?? []).toContain('j');
    expect(v.autoGate?.haltGeneric ?? false).toBe(false);
    expect(rig.flow.state(rig.wt).stepName).toBe(STEP);
  });

  it('a `human` gate reached before the relaunch shows no (j) after it (negative pair)', async () => {
    const before = makeRig({ authority: 'human' });
    expect(before.flowStart(before.wt).status).toBe('in_progress');
    writeAppLoopState(before.wt, { loop: LOOP, step: STEP, turnKey: TURN, status: 'complete', round: 1, verdict: 'clean' }, FIXED);

    const rig = before.relaunch();
    await flush();
    expect(rig.view().autoGate?.haltReasons ?? []).toEqual([]);
    expect((rig.gateEntries(T0) ?? []).filter((c) => gateDecisionDecider(c) === 'engine')).toEqual([]);
  });

  it('a failed-effect marker set before the relaunch is shown after it (N9b.5(d))', async () => {
    const before = makeRig({ approveThrows: () => true });
    expect(before.flowStart(before.wt).status).toBe('in_progress');
    await before.reachGate('clean');
    expect(before.view().autoGate?.failedEffect?.state).toBe('set');

    const rig = before.relaunch();
    await flush();
    expect(rig.view().autoGate?.failedEffect?.state).toBe('set');
  });

  it('a failed-effect marker set before the relaunch halts the run\'s next clean `auto` gate after it with (i)', async () => {
    const before = makeRig({ approveThrows: () => true });
    expect(before.flowStart(before.wt).status).toBe('in_progress');
    await before.reachGate('clean');
    expect(before.view().autoGate?.failedEffect?.state).toBe('set');

    const rig = before.relaunch();
    await rig.reachGate('clean');
    expect(rig.approvals).toEqual([]);
    expect(rig.view().autoGate?.haltReasons.map((r) => r.reason) ?? []).toContain('i');
  });
});

