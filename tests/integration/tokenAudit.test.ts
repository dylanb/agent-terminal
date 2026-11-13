import { describe, expect, it, onTestFinished } from 'vitest';
import { mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createAuditRecorder, type AuditRecorder, type AuditRecorderDeps } from '../../src/main/auditRecorder';
import { auditFilePath } from '../../src/main/auditPaths';
import { createTokenMeter } from '../../src/main/tokenMeter';
import { reconstructTimeline, type FlowLike, type RunTimeline, type TransitionKind } from '../../src/shared/audit';
import type { FlowTokensView } from '../../src/shared/ipc';
import { claudeCodeLogs, codexLogs, logsTempDir, type BilledTokens } from '../helpers/agentUsageLogs';
import type { AgentKind } from '../../src/shared/agentKind';

// Every window close appends the closed step's counts to its run's real §25 record, read through a token meter whose
// display setting is off; the record is read back with the shared reconstruction. Each run starts at an instant with
// milliseconds, which its record's header keeps only to the second.

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

const FLOW = 'token_audit-flow';
const T0 = Date.parse('2026-06-25T08:00:00.437Z');
const IN = (stepName: string): FlowLike => ({ status: 'in_progress', stepName });
const DONE = (stepName: string): FlowLike => ({ status: 'done', stepName });
const NOT_STARTED = (stepName: string): FlowLike => ({ status: 'not_started', stepName });

const A: BilledTokens = { cacheRead: 21_000, cacheWrite: 1_300, input: 70, output: 410 };
const B: BilledTokens = { cacheRead: 5_500, cacheWrite: 260, input: 12, output: 95 };

function auditRig(opts: { countsAtClose?: AuditRecorderDeps['countsAtClose'] } = {}) {
  const { dir } = logsTempDir('token-audit-', onTestFinished);
  const worktree = join(dir, 'repo');
  const auditRoot = join(dir, 'audit');
  const claudeConfigRoot = join(dir, 'claude');
  const codexHome = join(dir, 'codex');
  mkdirSync(worktree);
  let clock = T0;
  const logged: unknown[] = [];
  const recorders: AuditRecorder[] = [];
  const launch = (): AuditRecorder => {
    const meter = createTokenMeter({ auditRoot, logRoots: { claudeConfigRoot, codexHome }, schedule: { start: () => () => {} }, showing: false, now: () => clock, changed: () => {} });
    const recorder = createAuditRecorder({
      root: auditRoot,
      now: () => new Date(clock),
      flowName: () => FLOW,
      countsAtClose: opts.countsAtClose ?? ((run, step, closedAt) => meter.countsAtClose(run, step, closedAt)),
      log: (_message, error) => void logged.push(error),
    });
    recorders.push(recorder);
    return recorder;
  };
  let recorder = launch();
  const claude = claudeCodeLogs(claudeConfigRoot, worktree);
  const codex = codexLogs(codexHome, worktree);
  return {
    logged,
    claudeDir: claude.dir,
    codex,
    bill: (at: number, tokens: BilledTokens): void => void claude.bill({ at, tokens }),
    /** Starts a run that hosts `agents`, Claude Code unless told otherwise. */
    start(at: number, agents: AgentKind[] = ['claude-code']): void {
      clock = at;
      recorder.recordTransition(worktree, 'start', NOT_STARTED('one'), IN('one'), { startedAt: at, flow: FLOW });
      for (const agent of agents) recorder.recordHostedAgent(worktree, agent);
    },
    move(kind: Exclude<TransitionKind, 'start'>, before: FlowLike, after: FlowLike, at: number): void {
      clock = at;
      recorder.recordTransition(worktree, kind, before, after);
    },
    terminate(at: number): void {
      clock = at;
      recorder.recordTerminate(worktree);
    },
    /** A fresh recorder and meter, as the app has after a relaunch. */
    relaunch(): void {
      recorder = launch();
    },
    /** The record of the run started at `started`, once every count asked for so far has landed. */
    async record(started = T0): Promise<RunTimeline> {
      await Promise.all(recorders.map((r) => r.settled()));
      return reconstructTimeline(readFileSync(auditFilePath(auditRoot, worktree, FLOW, new Date(started)), 'utf8'));
    },
  };
}

describe('the audit record keeps each step\'s counts at every kind of window close, with the setting off', () => {
  it.each([
    {
      close: 'an Advance or gate decision',
      run: (r: ReturnType<typeof auditRig>) => r.move('advance', IN('one'), IN('two'), T0 + 2_000),
      steps: [{ step: 'one', counts: counted(A) }],
    },
    {
      close: 'completion',
      run: (r: ReturnType<typeof auditRig>) => r.move('advance', IN('one'), DONE('one'), T0 + 2_000),
      steps: [{ step: 'one', counts: counted(A) }],
    },
    {
      close: 'Terminate',
      run: (r: ReturnType<typeof auditRig>) => r.terminate(T0 + 2_000),
      steps: [{ step: 'one', counts: counted(A) }],
    },
    {
      close: 'a first-step rollback',
      run: (r: ReturnType<typeof auditRig>) => r.move('rollback', IN('one'), NOT_STARTED('one'), T0 + 2_000),
      steps: [{ step: 'one', counts: counted(A) }],
    },
  ])('$close closes step 1 with its counts', async ({ run, steps }) => {
    const r = auditRig();
    r.start(T0);
    r.bill(T0 + 1_000, A);
    run(r);
    r.bill(T0 + 3_000, B);

    expect((await r.record()).tokens).toEqual({ steps, run: runOf(A) });
  });

  it.each(['advance', 'rollback'] as const)('a step left back to the step before it (%s) closes with its counts', async (kind) => {
    const r = auditRig();
    r.start(T0);
    r.move('advance', IN('one'), IN('two'), T0 + 1_000);
    r.bill(T0 + 2_000, B);
    r.move(kind, IN('two'), IN('one'), T0 + 3_000);
    r.bill(T0 + 4_000, A);

    expect((await r.record()).tokens).toEqual({
      steps: [
        { step: 'one', counts: idle },
        { step: 'two', counts: counted(B) },
      ],
      run: runOf(B),
    });
  });

  it('keeps every later event of the run readable when an agent log carries a figure that is not a whole count', async () => {
    const r = auditRig();
    r.start(T0);
    r.bill(T0 + 1_000, { ...A, output: 410.5 });
    r.move('advance', IN('one'), IN('two'), T0 + 2_000);
    r.bill(T0 + 3_000, B);
    r.terminate(T0 + 4_000);

    const record = await r.record();
    expect(record.coverage).toBe('complete');
    expect(record.events.some((e) => e.type === 'flow.terminated')).toBe(true);
    expect(record.tokens?.steps.map((s) => s.step)).toEqual(['one', 'two']);
  });

  it('records a close whose counts sum past a whole count the reader accepts as unavailable, and keeps the run readable', async () => {
    const r = auditRig({ countsAtClose: async () => counted({ cacheRead: 2 ** 53, cacheWrite: 0, input: 0, output: 0 }) });
    r.start(T0);
    r.move('advance', IN('one'), IN('two'), T0 + 2_000);
    r.terminate(T0 + 4_000);

    const record = await r.record();
    expect(record.coverage).toBe('complete');
    expect(record.tokens?.steps).toEqual([
      { step: 'one', counts: { state: 'unavailable' } },
      { step: 'two', counts: { state: 'unavailable' } },
    ]);
  });

  it('writes each close\'s counts in the order the windows closed, whichever count is ready first', async () => {
    const r = auditRig({
      countsAtClose: (_run, step) =>
        step === 'one' ? new Promise((resolve) => setTimeout(() => resolve(counted(A)), 0)) : Promise.resolve(counted(B)),
    });
    r.start(T0);
    r.move('advance', IN('one'), IN('two'), T0 + 2_000);
    r.move('advance', IN('two'), DONE('two'), T0 + 4_000);

    const record = await r.record();
    expect(record.events.filter((e) => e.type === 'step.tokens').map((e) => e.ts)).toEqual([
      new Date(T0 + 2_000).toISOString(),
      new Date(T0 + 4_000).toISOString(),
    ]);
  });

  it('an earlier close\'s entry holds only the spend before it, even when the step was re-entered and closed again before its count was read', async () => {
    const r = auditRig();
    r.start(T0);
    r.bill(T0 + 1_000, A);
    r.move('advance', IN('one'), DONE('one'), T0 + 2_000);
    r.move('undo', DONE('one'), IN('one'), T0 + 3_000);
    r.bill(T0 + 3_500, B);
    r.move('advance', IN('one'), DONE('one'), T0 + 4_000);

    const entries = (await r.record()).events.flatMap((e) => (e.type === 'step.tokens' ? [{ ts: e.ts, counts: e.counts }] : []));
    expect(entries).toEqual([
      { ts: new Date(T0 + 2_000).toISOString(), counts: counted(A) },
      {
        ts: new Date(T0 + 4_000).toISOString(),
        counts: counted({ cacheRead: A.cacheRead + B.cacheRead, cacheWrite: A.cacheWrite + B.cacheWrite, input: A.input + B.input, output: A.output + B.output }),
      },
    ]);
  });

  it('an Undo or a Restart from a completed run closes no window, so writes no counts', async () => {
    const r = auditRig();
    r.start(T0);
    r.bill(T0 + 1_000, A);
    r.move('advance', IN('one'), DONE('one'), T0 + 2_000);
    r.move('undo', DONE('one'), IN('one'), T0 + 3_000);
    r.move('advance', IN('one'), DONE('one'), T0 + 4_000);
    r.move('restart', DONE('one'), IN('one'), T0 + 5_000);

    const record = await r.record();
    expect(record.events.filter((e) => e.type === 'step.tokens').map((e) => e.ts)).toEqual([
      new Date(T0 + 2_000).toISOString(),
      new Date(T0 + 4_000).toISOString(),
    ]);
    expect(record.tokens?.steps).toEqual([{ step: 'one', counts: counted(A) }]);
  });

  it('a close\'s counts land in its run\'s file even when Terminate finalizes the run meanwhile', async () => {
    const r = auditRig();
    r.start(T0);
    r.bill(T0 + 1_000, A);
    r.move('advance', IN('one'), IN('two'), T0 + 2_000);
    r.bill(T0 + 3_000, B);
    r.terminate(T0 + 4_000);

    expect((await r.record()).tokens).toEqual({
      steps: [
        { step: 'one', counts: counted(A) },
        { step: 'two', counts: counted(B) },
      ],
      run: runOf({ cacheRead: 26_500, cacheWrite: 1_560, input: 82, output: 505 }),
    });
  });

  it('Terminate followed at once by a new Start leaves each run\'s file with its own counts', async () => {
    const r = auditRig();
    r.start(T0);
    r.bill(T0 + 1_000, A);
    r.terminate(T0 + 2_000);
    r.start(T0 + 2_500);
    r.bill(T0 + 3_000, B);
    r.move('advance', IN('one'), IN('two'), T0 + 4_000);

    expect((await r.record(T0)).tokens?.steps).toEqual([{ step: 'one', counts: counted(A) }]);
    expect((await r.record(T0 + 2_500)).tokens?.steps).toEqual([{ step: 'one', counts: counted(B) }]);
  });
});

describe('the audit record\'s counts survive a relaunch', () => {
  it('a fresh recorder and meter at step 2 record step 2\'s counts when the run is terminated', async () => {
    const r = auditRig();
    r.start(T0);
    r.bill(T0 + 1_000, A);
    r.move('advance', IN('one'), IN('two'), T0 + 2_000);
    r.bill(T0 + 3_000, B);
    await r.record();

    r.relaunch();
    r.terminate(T0 + 4_000);

    expect((await r.record()).tokens?.steps).toEqual([
      { step: 'one', counts: counted(A) },
      { step: 'two', counts: counted(B) },
    ]);
  });

  it('a fresh recorder and meter at step 1 record its counts at a first-step rollback', async () => {
    const r = auditRig();
    r.start(T0);
    r.bill(T0 + 1_000, A);

    r.relaunch();
    r.move('rollback', IN('one'), NOT_STARTED('one'), T0 + 2_000);

    expect((await r.record()).tokens?.steps).toEqual([{ step: 'one', counts: counted(A) }]);
  });
});

describe('a count that cannot be computed', () => {
  it.each([
    ['throws', () => { throw new Error('the logs moved'); }],
    ['rejects', () => Promise.reject(new Error('the logs moved'))],
  ] as const)('never reaches the transition when it %s: the close is recorded, its counts are left out, and the failure is logged', async (_how, countsAtClose) => {
    const r = auditRig({ countsAtClose });
    r.start(T0);

    expect(() => r.move('advance', IN('one'), IN('two'), T0 + 2_000)).not.toThrow();

    const record = await r.record();
    expect(record.events.map((e) => e.type)).toEqual(['flow.started', 'agent.hosted', 'step.entered']);
    expect(record.tokens).toBeNull();
    expect(r.logged).toHaveLength(1);
  });
});

describe('the audit record keeps a Codex step\'s counts in the states its log reports', () => {
  it('a step that ran a Codex logging no cache-write figure closes with its cache writes recorded as not reported, not 0', async () => {
    const r = auditRig();
    const session = r.codex.session({ form: 'no-cache-write', at: T0 - 30_000 });
    r.start(T0, ['codex']);
    session.bill(T0 + 1_000, { cacheRead: 9_000, input: 140, output: 260 });
    r.move('advance', IN('one'), IN('two'), T0 + 2_000);

    expect((await r.record()).tokens?.steps).toEqual([
      { step: 'one', counts: { ...counted({ cacheRead: 9_000, cacheWrite: 0, input: 140, output: 260 }), kinds: { ...counted({ cacheRead: 9_000, cacheWrite: 0, input: 140, output: 260 }).kinds, cacheWrite: { reported: 'none' } } } },
    ]);
  });

  it('a step that ran a Codex 0.145.0+ closes with its cache-write figure', async () => {
    const r = auditRig();
    const session = r.codex.session({ form: 'cache-write', at: T0 - 30_000 });
    r.start(T0, ['codex']);
    session.bill(T0 + 1_000, { cacheRead: 20_000, cacheWrite: 1_200, input: 300, output: 430 });
    r.move('advance', IN('one'), IN('two'), T0 + 2_000);

    expect((await r.record()).tokens?.steps).toEqual([{ step: 'one', counts: counted({ cacheRead: 20_000, cacheWrite: 1_200, input: 300, output: 430 }) }]);
  });
});

describe('the audit record keeps a step left while its logs were unavailable as unavailable', () => {
  it('step 2 closed over a dangling symlink reconstructs unavailable and the run total step 1\'s marked incomplete, and stays so once the link is removed', async () => {
    const r = auditRig();
    r.start(T0);
    r.bill(T0 + 1_000, A);
    r.move('advance', IN('one'), IN('two'), T0 + 2_000);
    await r.record();
    const dangling = join(r.claudeDir, 'dangling.jsonl');
    symlinkSync(join(r.claudeDir, 'gone.jsonl'), dangling);
    r.bill(T0 + 3_000, B);
    r.move('advance', IN('two'), DONE('two'), T0 + 4_000);

    const expected = {
      steps: [
        { step: 'one', counts: counted(A) },
        { step: 'two', counts: { state: 'unavailable' } },
      ],
      run: { state: 'counted', someStepsUnavailable: true, kinds: counted(A).kinds },
    };
    expect((await r.record()).tokens).toEqual(expected);

    rmSync(dangling);
    expect((await r.record()).tokens).toEqual(expected);
  });
});
