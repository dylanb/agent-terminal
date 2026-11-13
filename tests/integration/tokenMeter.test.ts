import { describe, expect, it, onTestFinished } from 'vitest';
import { rmSync } from 'node:fs';
import type { FlowLoopView, FlowStateView, FlowTokensView } from '../../src/shared/ipc';
import type { BilledTokens } from '../helpers/agentUsageLogs';
import { meterRig, type MeterRig } from '../helpers/tokenMeterRig';

// The meter decorates the views main returns with the run's counts, read from the real §25 record the recorder
// writes and the Claude Code logs the fixture writers write; its refresh runs only when the test steps it.

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
const runOf = (t: BilledTokens): FlowTokensView['run'] => ({ state: 'counted', someStepsUnavailable: false, kinds: counted(t).kinds });

const T0 = Date.parse('2026-06-24T09:00:00.120Z');
const PLAN_SPEND: BilledTokens = { cacheRead: 31_000, cacheWrite: 2_400, input: 88, output: 610 };

const rig = (): MeterRig => meterRig(onTestFinished, { startedAt: T0 });

describe('the token view on the flow views main returns', () => {
  it('rides an Advance and an Undo response, with the step counting moved and completion counting none', async () => {
    const r = rig();
    const meter = r.meterOn(true);
    const repo = r.worktree;
    meter.withTokens(repo, r.start());
    r.bill(T0 + 1_000, PLAN_SPEND);
    await r.tick();

    expect(meter.withTokens(repo, r.advance(T0 + 2_000)).tokens).toEqual({ steps: [counted(PLAN_SPEND), idle], counting: 1, run: runOf(PLAN_SPEND) });
    expect(meter.withTokens(repo, r.advance(T0 + 3_000)).tokens).toEqual({ steps: [counted(PLAN_SPEND), idle], counting: null, run: runOf(PLAN_SPEND) });
    expect(meter.withTokens(repo, r.undo(T0 + 4_000)).tokens).toEqual({ steps: [counted(PLAN_SPEND), idle], counting: 1, run: runOf(PLAN_SPEND) });
  });

  it('marks the open step counting whatever its loop is doing: working, at a gate, stopped in error, or a manual step', async () => {
    const r = rig();
    const meter = r.meterOn(true);
    const repo = r.worktree;
    meter.withTokens(repo, r.start());
    await r.tick();
    const loop = (over: Partial<FlowLoopView>): FlowLoopView => ({ status: 'working', pr: null, branch: null, ready: false, ...over });
    const counting = (view: FlowStateView): number | null | undefined => meter.withTokens(repo, view).tokens?.counting;

    expect({
      working: counting({ ...r.state(), loop: loop({ humanNeeded: false }) }),
      gate: counting({ ...r.state(), loop: loop({ status: 'awaiting-human', humanNeeded: true, gateOptions: ['approve'] }) }),
      error: counting({ ...r.state(), loop: loop({ status: 'error', humanNeeded: false }) }),
      manual: counting(r.state()),
    }).toEqual({ working: 0, gate: 0, error: 0, manual: 0 });
  });

  it('shows a dash for every step and the run total once the run is terminated', async () => {
    const r = rig();
    const meter = r.meterOn(true);
    const repo = r.worktree;
    meter.withTokens(repo, r.start());
    r.bill(T0 + 1_000, PLAN_SPEND);
    await r.tick();

    expect(meter.withTokens(repo, r.terminate(T0 + 2_000)).tokens).toEqual({ steps: [null, null], counting: null, run: null });
  });

  it('gives each pull its own copy, so changing one leaves the next unchanged', async () => {
    const r = rig();
    const meter = r.meterOn(true);
    const repo = r.worktree;
    meter.withTokens(repo, r.start());
    r.bill(T0 + 1_000, PLAN_SPEND);
    await r.tick();
    const first = meter.withTokens(repo, r.state()).tokens!;
    first.steps[0] = null;
    first.counting = 7;

    expect(meter.withTokens(repo, r.state()).tokens).toEqual({ steps: [counted(PLAN_SPEND), null], counting: 0, run: runOf(PLAN_SPEND) });
  });
});

describe('the live meter', () => {
  it('puts dashes on the first pull of a repo it has not read yet, so the view keeps its shape when the counts arrive', () => {
    const r = rig();
    const meter = r.meterOn(true);

    expect(meter.withTokens(r.worktree, r.start()).tokens).toEqual({ steps: [null, null], counting: null, run: null });
  });

  it('pushes after a scheduled refresh finds more spend, and the next pull shows the higher count', async () => {
    const r = rig();
    const meter = r.meterOn(true);
    const repo = r.worktree;
    meter.withTokens(repo, r.start());
    r.bill(T0 + 1_000, PLAN_SPEND);
    await r.tick();
    expect(meter.withTokens(repo, r.state()).tokens?.steps[0]).toEqual(counted(PLAN_SPEND));
    const before = r.pushes();

    r.bill(T0 + 2_000, { cacheRead: 4_000, cacheWrite: 100, input: 2, output: 90 });
    await r.tick();

    expect({ pushed: r.pushes() - before, step: meter.withTokens(repo, r.state()).tokens?.steps[0] }).toEqual({
      pushed: 1,
      step: counted({ cacheRead: 35_000, cacheWrite: 2_500, input: 90, output: 700 }),
    });
  });

  it('pushes nothing when a scheduled refresh finds the logs unchanged', async () => {
    const r = rig();
    const meter = r.meterOn(true);
    const repo = r.worktree;
    meter.withTokens(repo, r.start());
    r.bill(T0 + 1_000, PLAN_SPEND);
    await r.tick();
    meter.withTokens(repo, r.state());
    const before = r.pushes();

    await r.tick();
    await r.tick();

    expect(r.pushes() - before).toBe(0);
  });

  it('turning the setting off pushes, drops the counts from the next pull and stops refreshing', async () => {
    const r = rig();
    const meter = r.meterOn(true);
    const repo = r.worktree;
    meter.withTokens(repo, r.start());
    r.bill(T0 + 1_000, PLAN_SPEND);
    await r.tick();
    const before = r.pushes();

    await meter.setShowing(false);

    expect({ pushed: r.pushes() - before, tokens: meter.withTokens(repo, r.state()).tokens, refreshing: r.scheduled() }).toEqual({
      pushed: 1,
      tokens: undefined,
      refreshing: false,
    });
  });

  it('turning the setting on again over unchanged logs pushes, and the next pull shows the counts', async () => {
    const r = rig();
    const meter = r.meterOn(false);
    const repo = r.worktree;
    meter.withTokens(repo, r.start());
    r.bill(T0 + 1_000, PLAN_SPEND);
    expect(meter.withTokens(repo, r.state()).tokens).toBeUndefined();
    const before = r.pushes();

    await meter.setShowing(true);

    expect({ pushed: r.pushes() - before, tokens: meter.withTokens(repo, r.state()).tokens }).toEqual({
      pushed: 1,
      tokens: { steps: [counted(PLAN_SPEND), null], counting: 0, run: runOf(PLAN_SPEND) },
    });
  });
});

describe('the live meter once a run is finished', () => {
  it('counts what was billed in the last step before the run finished, though no refresh ran in between', async () => {
    const r = rig();
    const meter = r.meterOn(true);
    const repo = r.worktree;
    meter.withTokens(repo, r.start());
    r.bill(T0 + 1_000, PLAN_SPEND);
    await r.tick();
    meter.withTokens(repo, r.advance(T0 + 2_000));
    await r.tick();
    r.bill(T0 + 2_500, PLAN_SPEND);
    meter.withTokens(repo, r.advance(T0 + 3_000));

    await r.tick();

    expect(meter.withTokens(repo, r.state()).tokens).toEqual({ steps: [counted(PLAN_SPEND), counted(PLAN_SPEND)], counting: null, run: runOf({ cacheRead: 62_000, cacheWrite: 4_800, input: 176, output: 1_220 }) });
  });

  it('stops reading a finished run\'s logs once it has counted them', async () => {
    const r = rig();
    const meter = r.meterOn(true);
    const repo = r.worktree;
    meter.withTokens(repo, r.start());
    r.bill(T0 + 1_000, PLAN_SPEND);
    meter.withTokens(repo, r.advance(T0 + 2_000));
    meter.withTokens(repo, r.advance(T0 + 3_000));
    await r.tick();
    const finished = meter.withTokens(repo, r.state()).tokens;
    rmSync(r.claude.dir, { recursive: true });

    await r.tick();

    expect(meter.withTokens(repo, r.state()).tokens).toEqual(finished);
  });
});
