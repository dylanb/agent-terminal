import { describe, expect, it, onTestFinished } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlowStateView, FlowTokensView } from '../../src/shared/ipc';
import { createFlowManager, flowCatalogDir, FLOW_DEF_FILE } from '../../src/main/flow';
import { createRunResolver } from '../../src/main/runResolver';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { createAuditRecorder } from '../../src/main/auditRecorder';
import { readAuditRun } from '../../src/main/auditRun';
import { sweepAgentUsage } from '../../src/main/agentUsage/sweep';
import { stepTokens } from '../../src/main/stepTokens';
import { createFlowLifecycle } from '../../src/main/flowLifecycle';
import { createWorktreeLock } from '../../src/main/worktreeLock';
import { createPendingNotices } from '../../src/main/pendingNotices';
import { claudeCodeLogs, logsTempDir, type BilledTokens } from '../helpers/agentUsageLogs';
import { createTokenRun } from '../helpers/tokenRun';
import { repoOnlyDefTiers } from '../helpers/defTiers';

// A step entered again in the same run adds its new window's spend to its earlier windows' (Scope 8); the windows
// are rebuilt from the run's real §25 record.

type StepCounts = Extract<NonNullable<FlowTokensView['steps'][number]>, { state: 'counted' }>;

const counted = (t: BilledTokens): StepCounts => ({
  state: 'counted',
  billed: true,
  kinds: {
    cacheRead: { reported: 'all', n: t.cacheRead },
    cacheWrite: { reported: 'all', n: t.cacheWrite },
    input: { reported: 'all', n: t.input },
    output: { reported: 'all', n: t.output },
  },
});

const idle: StepCounts = { ...counted({ cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }), billed: false };

const T0 = Date.parse('2026-06-23T11:00:00.250Z');
const IN = (stepName: string) => ({ status: 'in_progress' as const, stepName });
const DONE = (stepName: string) => ({ status: 'done' as const, stepName });

describe('re-entered steps add up across their windows', () => {
  it('a repeat jump back to an earlier step adds its new spend, and spend at the step between stays there', async () => {
    const run = createTokenRun(onTestFinished, T0);
    run.start('red', T0);
    run.host('claude-code', T0);
    run.claude.bill({ at: T0 + 1_000, tokens: { cacheRead: 10_000, cacheWrite: 1_000, input: 100, output: 200 } });
    run.move('advance', IN('red'), IN('review'), T0 + 2_000);
    run.claude.bill({ at: T0 + 3_000, tokens: { cacheRead: 4_000, cacheWrite: 300, input: 20, output: 60 } });
    run.move('advance', IN('review'), IN('red'), T0 + 4_000);
    run.claude.bill({ at: T0 + 5_000, tokens: { cacheRead: 2_500, cacheWrite: 150, input: 7, output: 33 } });

    expect(await run.tokens(['red', 'review'])).toMatchObject({
      steps: [
        counted({ cacheRead: 12_500, cacheWrite: 1_150, input: 107, output: 233 }),
        counted({ cacheRead: 4_000, cacheWrite: 300, input: 20, output: 60 }),
      ],
      counting: 0,
    });
  });

  it('Undo on a completed flow reopens its last step, which adds its new spend; spend while completed counts nowhere', async () => {
    const run = createTokenRun(onTestFinished, T0);
    run.start('plan', T0);
    run.host('claude-code', T0);
    run.move('advance', IN('plan'), IN('build'), T0 + 1_000);
    run.claude.bill({ at: T0 + 2_000, tokens: { cacheRead: 6_000, cacheWrite: 600, input: 60, output: 66 } });
    run.move('advance', IN('build'), DONE('build'), T0 + 3_000);
    run.claude.bill({ at: T0 + 4_000, tokens: { cacheRead: 500_000, cacheWrite: 50_000, input: 5_000, output: 5_500 } });
    run.move('undo', DONE('build'), IN('build'), T0 + 5_000);
    run.claude.bill({ at: T0 + 6_000, tokens: { cacheRead: 1_200, cacheWrite: 34, input: 5, output: 17 } });

    expect(await run.tokens(['plan', 'build'])).toMatchObject({
      steps: [idle, counted({ cacheRead: 7_200, cacheWrite: 634, input: 65, output: 83 })],
      counting: 1,
    });
  });

  it('Restart on a completed flow re-enters step 1, which adds its new spend to its first window\'s', async () => {
    const run = createTokenRun(onTestFinished, T0);
    run.start('plan', T0);
    run.host('claude-code', T0);
    run.claude.bill({ at: T0 + 1_000, tokens: { cacheRead: 8_800, cacheWrite: 770, input: 66, output: 55 } });
    run.move('advance', IN('plan'), IN('build'), T0 + 2_000);
    run.claude.bill({ at: T0 + 3_000, tokens: { cacheRead: 1_100, cacheWrite: 220, input: 33, output: 44 } });
    run.move('advance', IN('build'), DONE('build'), T0 + 4_000);
    run.move('restart', DONE('build'), IN('plan'), T0 + 5_000);
    run.claude.bill({ at: T0 + 6_000, tokens: { cacheRead: 300, cacheWrite: 12, input: 4, output: 9 } });

    expect(await run.tokens(['plan', 'build'])).toMatchObject({
      steps: [
        counted({ cacheRead: 9_100, cacheWrite: 782, input: 70, output: 64 }),
        counted({ cacheRead: 1_100, cacheWrite: 220, input: 33, output: 44 }),
      ],
      counting: 0,
    });
  });

  it('Terminate closes the open window: spend after it counts nowhere and no step is still counting', async () => {
    const run = createTokenRun(onTestFinished, T0);
    run.start('plan', T0);
    run.host('claude-code', T0);
    run.claude.bill({ at: T0 + 1_000, tokens: { cacheRead: 2_200, cacheWrite: 110, input: 9, output: 18 } });
    run.terminate(T0 + 2_000);
    run.claude.bill({ at: T0 + 3_000, tokens: { cacheRead: 900_000, cacheWrite: 1, input: 1, output: 1 } });

    expect(await run.tokens(['plan'])).toMatchObject({
      steps: [counted({ cacheRead: 2_200, cacheWrite: 110, input: 9, output: 18 })],
      counting: null,
    });
  });
});

// A step that fails to start is rolled back by the flow lifecycle, which closes its window in the run's real §25
// record; the counts are read back from that record as the app reads them.
const ROLLBACK_FLOW = 'Rollback Flow';
const ROLLBACK_STEPS = ['one', 'two', 'three'];

function rollbackRun(startedAt: number) {
  const { dir } = logsTempDir('token-rollback-', onTestFinished);
  const worktree = join(dir, 'repo');
  const globalDir = join(dir, 'global');
  const auditRoot = join(dir, 'audit');
  const claudeConfigRoot = join(dir, 'claude');
  const codexHome = join(dir, 'codex');
  mkdirSync(join(worktree, '.agent-terminal'), { recursive: true });
  mkdirSync(globalDir);
  const entry = join(flowCatalogDir(worktree), 'rollback-flow');
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, FLOW_DEF_FILE), `name: ${ROLLBACK_FLOW}\nsteps:\n${ROLLBACK_STEPS.map((id) => `  - id: ${id}\n    kind: manual\n`).join('')}`);
  writeActiveFlow(worktree, 'rollback-flow');
  const resolve = createRunResolver(globalDir, repoOnlyDefTiers());
  const flow = createFlowManager({ globalDir, loadDefinition: (repoKey) => resolve(repoKey) });
  let clock = startedAt;
  const recorder = createAuditRecorder({ root: auditRoot, now: () => new Date(clock), flowName: () => ROLLBACK_FLOW });
  const lock = createWorktreeLock({ lockRoot: join(dir, 'locks'), holderLiveness: () => 'live-matching' });
  const lifecycle = createFlowLifecycle({
    lock,
    flow,
    recovery: { rebind: () => ({ ok: false, reason: 'no rebind in this test' }) },
    pendingNotices: createPendingNotices(),
    loopTurnActive: () => false,
    forgetRunEntry: () => {},
    endRun: () => {},
    recordTerminate: (repoKey) => recorder.recordTerminate(repoKey),
    recordRollback: (repoKey, before, after) => recorder.recordTransition(repoKey, 'rollback', before, after),
    clearTodos: () => {},
    clearSliceBrief: () => {},
    clearMonitor: () => {},
    flowChanged: () => {},
    releaseLoopTurn: () => {},
    presentView: (_repoKey, view) => view,
  });
  const claude = claudeCodeLogs(claudeConfigRoot, worktree);
  return {
    bill: (at: number, tokens: BilledTokens): void => void claude.bill({ at, tokens }),
    start(at: number): FlowStateView {
      clock = at;
      const view = flow.start(worktree, { startedAt: at });
      recorder.recordTransition(worktree, 'start', { status: 'not_started', stepName: '' }, view, { startedAt: at, flow: ROLLBACK_FLOW });
      recorder.recordHostedAgent(worktree, 'claude-code');
      return view;
    },
    advance(at: number): FlowStateView {
      clock = at;
      const before = flow.state(worktree);
      const after = flow.advance(worktree);
      recorder.recordTransition(worktree, 'advance', before, after);
      return after;
    },
    rollback(step: string, at: number): FlowStateView {
      clock = at;
      return lifecycle.rollbackStep(worktree, step);
    },
    /** The counts of the run started at `started`, as the app reads them now. */
    async tokens(started: number): Promise<FlowTokensView> {
      const run = readAuditRun(auditRoot, { repoPath: worktree, flow: ROLLBACK_FLOW, started: new Date(started) });
      const sweep = await sweepAgentUsage({ claudeConfigRoot, codexHome }, worktree, run.agents, started);
      return stepTokens(run.visits, ROLLBACK_STEPS, sweep, clock);
    },
  };
}

describe('a rollback closes the failed step\'s window', () => {
  const R0 = Date.parse('2026-06-23T13:00:00.437Z');

  it('a step that fails to start keeps its spend, and the step rolled back to adds its new spend to its earlier count', async () => {
    const run = rollbackRun(R0);
    run.start(R0);
    run.bill(R0 + 1_000, { cacheRead: 7_000, cacheWrite: 500, input: 40, output: 90 });
    run.advance(R0 + 2_000);
    run.bill(R0 + 3_000, { cacheRead: 2_000, cacheWrite: 120, input: 11, output: 25 });
    expect(run.rollback('two', R0 + 4_000)).toMatchObject({ status: 'in_progress', stepName: 'one' });
    run.bill(R0 + 5_000, { cacheRead: 800, cacheWrite: 30, input: 3, output: 7 });

    expect(await run.tokens(R0)).toMatchObject({
      steps: [
        counted({ cacheRead: 7_800, cacheWrite: 530, input: 43, output: 97 }),
        counted({ cacheRead: 2_000, cacheWrite: 120, input: 11, output: 25 }),
        null,
      ],
      counting: 0,
    });
  });

  it('a first-step rollback closes step 1\'s window: spend after it counts nowhere, and a new Start counts only its own', async () => {
    const run = rollbackRun(R0);
    run.start(R0);
    run.bill(R0 + 1_000, { cacheRead: 4_400, cacheWrite: 330, input: 22, output: 66 });
    expect(run.rollback('one', R0 + 2_000)).toMatchObject({ status: 'not_started' });
    run.bill(R0 + 3_000, { cacheRead: 900_000, cacheWrite: 1, input: 1, output: 1 });

    expect(await run.tokens(R0)).toMatchObject({
      steps: [counted({ cacheRead: 4_400, cacheWrite: 330, input: 22, output: 66 }), null, null],
      counting: null,
    });

    run.start(R0 + 4_000);
    run.bill(R0 + 5_000, { cacheRead: 600, cacheWrite: 40, input: 5, output: 8 });

    expect(await run.tokens(R0 + 4_000)).toMatchObject({
      steps: [counted({ cacheRead: 600, cacheWrite: 40, input: 5, output: 8 }), null, null],
      counting: 0,
    });
  });
});
