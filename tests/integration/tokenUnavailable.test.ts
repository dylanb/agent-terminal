import { describe, expect, it, onTestFinished } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { auditFilePath } from '../../src/main/auditPaths';
import type { FlowStateView, FlowTokensView } from '../../src/shared/ipc';
import { agentWorkingDir } from '../../src/main/agentUsage/logRoots';
import { unreadableLogsProvokable, type BilledTokens } from '../helpers/agentUsageLogs';
import { METER_FLOW, meterRig, type MeterRig } from '../helpers/tokenMeterRig';

// "Unavailable" and "incomplete" over real logs: the meter decorates the views a real flow returns with counts read
// from the real §25 record and fixture logs, some of them broken for real. A file or folder the app cannot read is
// made with chmod, which root reads through, so those cases run only on a developer's host (and on one whose temp
// filesystem reports creation times); each places the step windows and the clock around the times its broken file
// actually has. Every whole-run case then advances the flow, which carries on.

type StepCounts = Extract<NonNullable<FlowTokensView['steps'][number]>, { state: 'counted' }>;
type Cell = StepCounts['kinds']['cacheWrite'];

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
const withCacheWrite = (step: StepCounts, cacheWrite: Cell): StepCounts => ({ ...step, kinds: { ...step.kinds, cacheWrite } });
const idle: StepCounts = { ...counted({ cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }), billed: false };
const U = { state: 'unavailable' } as const;
const incomplete = (kinds: StepCounts['kinds']): FlowTokensView['run'] => ({ state: 'counted', someStepsUnavailable: true, kinds });
const whole = (kinds: StepCounts['kinds']): FlowTokensView['run'] => ({ state: 'counted', someStepsUnavailable: false, kinds });

const STEPS = ['one', 'two', 'three'];
const T0 = Date.parse('2026-06-26T11:00:00.250Z');
/** Before every run here, so a call logged then counts nowhere. */
const P0 = Date.parse('2026-06-01T08:00:00.000Z');
const ONE: BilledTokens = { cacheRead: 12_000, cacheWrite: 340, input: 56, output: 78 };
const TWO: BilledTokens = { cacheRead: 3_000, cacheWrite: 210, input: 9, output: 40 };

const rig = (): MeterRig => meterRig(onTestFinished, { steps: STEPS, startedAt: T0 });
const provokable = unreadableLogsProvokable();

const shown = async (r: MeterRig, meter: ReturnType<MeterRig['meterOn']>): Promise<FlowTokensView | undefined> => {
  await r.tick();
  return meter.withTokens(r.worktree, r.state()).tokens;
};

/** A whole-run case at step one: it and the run total read unavailable, the later steps a dash; an Advance then
 *  succeeds and both entered steps read unavailable. */
async function expectWholeRunUnavailable(r: MeterRig, advanceAt = T0 + 10_000): Promise<void> {
  const meter = r.meterOn(true);
  meter.withTokens(r.worktree, r.state());
  expect(await shown(r, meter)).toEqual({ steps: [U, null, null], counting: 0, run: U });

  const advanced: FlowStateView = meter.withTokens(r.worktree, r.advance(advanceAt));
  expect({ status: advanced.status, step: advanced.stepName, tokens: advanced.tokens }).toEqual({
    status: 'in_progress',
    step: 'two',
    tokens: { steps: [U, U, null], counting: 1, run: U },
  });
}

/** The real creation time of a log file just written, to the millisecond. */
const createdAt = (file: string): number => Math.floor(statSync(file).birthtimeMs);
const modifiedAt = (file: string): number => Math.ceil(statSync(file).mtimeMs);

describe.skipIf(!provokable)('an unreadable log file makes unavailable only the entered steps whose windows overlap its span (host only)', () => {
  it('a Claude Code file spanning step 2 only: step 2 unavailable, step 1 counted, step 3 a dash, the run total incomplete; the flow advances; readable again, numbers and no marker', async () => {
    const r = rig();
    const later = join(r.claude.dir, 'later-session.jsonl');
    r.claude.bill({ at: P0, session: 'later-session', tokens: { cacheRead: 900_000, cacheWrite: 1, input: 1, output: 1 } });
    const born = createdAt(later);
    const start = born - 20_000;
    r.start({ at: start });
    r.bill(start + 1_000, ONE);
    r.advance(born - 10_000);
    r.claude.bill({ at: born - 5_000, session: 'later-session', tokens: TWO });
    r.logs.makeUnreadable(later);
    r.setNow(modifiedAt(later) + 1_000);
    const meter = r.meterOn(true);
    meter.withTokens(r.worktree, r.state());

    expect(await shown(r, meter)).toEqual({ steps: [counted(ONE), U, null], counting: 1, run: incomplete(counted(ONE).kinds) });

    const advanced = meter.withTokens(r.worktree, r.advance(modifiedAt(later) + 2_000));
    expect({ step: advanced.stepName, tokens: advanced.tokens }).toEqual({
      step: 'three',
      tokens: { steps: [counted(ONE), U, idle], counting: 2, run: incomplete(counted(ONE).kinds) },
    });

    chmodSync(later, 0o644);
    expect(await shown(r, meter)).toEqual({
      steps: [counted(ONE), counted(TWO), idle],
      counting: 2,
      run: whole(counted({ cacheRead: 15_000, cacheWrite: 550, input: 65, output: 118 }).kinds),
    });
  });

  it('a file in Codex\'s shared folder whose working directory cannot be read counts as this worktree\'s, spanning step 2 only', async () => {
    const r = rig();
    const own = r.codex.session({ form: 'cache-write', at: P0 });
    const broken = r.codex.session({ form: 'cache-write', at: P0 });
    const born = createdAt(broken.file);
    const start = born - 20_000;
    r.start({ at: start, agents: ['codex'] });
    own.bill(start + 1_000, ONE);
    r.advance(born - 10_000);
    broken.bill(born - 5_000, TWO);
    r.logs.makeUnreadable(broken.file);
    r.setNow(modifiedAt(broken.file) + 1_000);
    const meter = r.meterOn(true);
    meter.withTokens(r.worktree, r.state());

    expect(await shown(r, meter)).toEqual({ steps: [counted(ONE), U, null], counting: 1, run: incomplete(counted(ONE).kinds) });

    chmodSync(broken.file, 0o644);
    expect((await shown(r, meter))?.steps).toEqual([counted(ONE), counted(TWO), null]);
  });

  it('when the only entered step is unavailable the run total reads unavailable, not 0 marked incomplete; the flow advances', async () => {
    const r = rig();
    const later = join(r.claude.dir, 'later-session.jsonl');
    r.claude.bill({ at: P0, session: 'later-session', tokens: TWO });
    const born = createdAt(later);
    r.start({ at: born - 20_000 });
    r.logs.makeUnreadable(later);
    r.setNow(modifiedAt(later) + 1_000);
    const meter = r.meterOn(true);
    meter.withTokens(r.worktree, r.state());

    expect(await shown(r, meter)).toEqual({ steps: [U, null, null], counting: 0, run: U });
    expect(meter.withTokens(r.worktree, r.advance(modifiedAt(later) + 2_000)).tokens).toEqual({ steps: [U, idle, null], counting: 1, run: incomplete(idle.kinds) });
  });

  it('a run total whose countable steps are a Claude Code step and an earlier-Codex step reads cache writes partly reported and incomplete', async () => {
    const r = rig();
    const later = join(r.claude.dir, 'later-session.jsonl');
    r.claude.bill({ at: P0, session: 'later-session', tokens: TWO });
    const born = createdAt(later);
    const earlier = r.codex.session({ form: 'no-cache-write', at: P0 });
    const start = born - 30_000;
    r.start({ at: start, agents: ['claude-code', 'codex'] });
    r.bill(start + 1_000, ONE);
    r.advance(start + 5_000);
    earlier.bill(start + 6_000, { cacheRead: 9_000, input: 140, output: 260 });
    r.advance(born - 10_000);
    r.logs.makeUnreadable(later);
    r.setNow(modifiedAt(later) + 1_000);
    const meter = r.meterOn(true);
    meter.withTokens(r.worktree, r.state());

    const codexStep = withCacheWrite(counted({ cacheRead: 9_000, cacheWrite: 0, input: 140, output: 260 }), { reported: 'none' });
    expect(await shown(r, meter)).toEqual({
      steps: [counted(ONE), codexStep, U],
      counting: 2,
      run: incomplete(withCacheWrite(counted({ cacheRead: 21_000, cacheWrite: 0, input: 196, output: 338 }), { reported: 'some', n: 340 }).kinds),
    });
  });

  it('a run total whose only countable step is an earlier-Codex step reads cache writes not reported, marked incomplete', async () => {
    const r = rig();
    const earlier = r.codex.session({ form: 'no-cache-write', at: P0 });
    const later = join(r.claude.dir, 'later-session.jsonl');
    r.claude.bill({ at: P0, session: 'later-session', tokens: TWO });
    const born = createdAt(later);
    const start = born - 20_000;
    r.start({ at: start, agents: ['claude-code', 'codex'] });
    earlier.bill(start + 1_000, { cacheRead: 9_000, input: 140, output: 260 });
    r.advance(born - 10_000);
    r.logs.makeUnreadable(later);
    r.setNow(modifiedAt(later) + 1_000);
    const meter = r.meterOn(true);
    meter.withTokens(r.worktree, r.state());

    const codexStep = withCacheWrite(counted({ cacheRead: 9_000, cacheWrite: 0, input: 140, output: 260 }), { reported: 'none' });
    expect(await shown(r, meter)).toEqual({ steps: [codexStep, U, null], counting: 1, run: incomplete(codexStep.kinds) });
  });
});

describe('a log the app cannot place in time, or cannot find, makes the whole run unavailable', () => {
  it('a dangling symlink in the worktree\'s Claude Code log folder: a file whose times cannot be read', async () => {
    const r = rig();
    r.start();
    r.bill(T0 + 1_000, ONE);
    symlinkSync(join(r.claude.dir, 'gone.jsonl'), join(r.claude.dir, 'dangling.jsonl'));

    await expectWholeRunUnavailable(r);
  });

  it('the worktree\'s Claude Code log folder is missing while Codex has logs for the worktree', async () => {
    const r = rig();
    const codex = r.codex.session({ form: 'cache-write', at: P0 });
    r.start({ agents: ['claude-code', 'codex'] });
    codex.bill(T0 + 1_000, ONE);

    await expectWholeRunUnavailable(r);
  });

  it('Codex\'s log folder is missing while Claude Code has logs for the worktree', async () => {
    const r = rig();
    r.start({ agents: ['claude-code', 'codex'] });
    r.bill(T0 + 1_000, ONE);

    await expectWholeRunUnavailable(r);
  });

  it('no supported agent has logs for the worktree, in a run that hosted none', async () => {
    const r = rig();
    r.start({ agents: [] });

    await expectWholeRunUnavailable(r);
  });

  it('a run that hosted no agent shows 0 when an agent has logs for the worktree', async () => {
    const r = rig();
    r.claude.bill({ at: P0, tokens: ONE });
    r.start({ agents: [] });
    const meter = r.meterOn(true);
    meter.withTokens(r.worktree, r.state());

    expect(await shown(r, meter)).toEqual({ steps: [idle, null, null], counting: 0, run: whole(idle.kinds) });
  });

  it('a run that hosted no agent shows 0 when only Codex has logs for the worktree', async () => {
    const r = rig();
    r.codex.session({ form: 'cache-write', at: P0 }).bill(P0 + 1_000, TWO);
    r.start({ agents: [] });
    const meter = r.meterOn(true);
    meter.withTokens(r.worktree, r.state());

    expect(await shown(r, meter)).toEqual({ steps: [idle, null, null], counting: 0, run: whole(idle.kinds) });
  });

  it('a run that hosted no agent is unavailable when Codex\'s only logs are another worktree\'s', async () => {
    const r = rig();
    r.codex.session({ form: 'cache-write', at: P0, cwd: join(r.worktree, '..', 'another-worktree') }).bill(P0 + 1_000, TWO);
    r.start({ agents: [] });

    await expectWholeRunUnavailable(r);
  });

  it('a run that hosted no agent shows 0 when the worktree\'s Codex rollout opens with a session line longer than one read', async () => {
    const r = rig();
    const file = join(r.codex.dir, '2026', '06', '01', 'rollout-2026-06-01T08-00-00-00000000-0000-4000-8000-000000000001.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    const meta = { timestamp: new Date(P0).toISOString(), type: 'session_meta', payload: { id: 'long', cwd: agentWorkingDir(r.worktree), instructions: 'x'.repeat(70 * 1024) } };
    writeFileSync(file, `${JSON.stringify(meta)}\n`);
    r.start({ agents: [] });
    const meter = r.meterOn(true);
    meter.withTokens(r.worktree, r.state());

    expect(await shown(r, meter)).toEqual({ steps: [idle, null, null], counting: 0, run: whole(idle.kinds) });
  });

  it.each([
    [
      'flow-state.yaml records no start',
      (r: MeterRig): void => {
        const file = join(r.worktree, '.agent-terminal', 'flow-state.yaml');
        writeFileSync(file, readFileSync(file, 'utf8').replace(/^started_at:.*\n/m, ''));
      },
    ],
    ['the run\'s record cannot be found', (r: MeterRig): void => rmSync(auditFilePath(r.auditRoot, r.worktree, METER_FLOW, new Date(T0)))],
  ])('the run has no recorded start: %s', async (_case, lose) => {
    const r = rig();
    r.start();
    r.bill(T0 + 1_000, ONE);
    lose(r);

    await expectWholeRunUnavailable(r);
  });
});

describe('an agent that ran with no log file for the worktree modified since the run started makes the whole run unavailable', () => {
  it('Codex ran and the shared folder holds only another worktree\'s rollout files, while Claude Code has spend in the window', async () => {
    const r = rig();
    const foreign = r.codex.session({ form: 'cache-write', at: P0, cwd: join(r.worktree, '..', 'another-worktree') });
    r.start({ agents: ['claude-code', 'codex'] });
    r.bill(T0 + 1_000, ONE);
    foreign.bill(T0 + 2_000, TWO);

    await expectWholeRunUnavailable(r);
  });

  it('Codex ran and this worktree\'s only rollout file was last modified before the run started, while Claude Code has spend in the window', async () => {
    const r = rig();
    const own = r.codex.session({ form: 'cache-write', at: P0 });
    own.bill(P0 + 1_000, TWO);
    utimesSync(own.file, new Date(P0 + 2_000), new Date(P0 + 2_000));
    r.start({ agents: ['claude-code', 'codex'] });
    r.bill(T0 + 1_000, ONE);

    await expectWholeRunUnavailable(r);
  });

  it('Claude Code ran and its log folder holds no file modified since the run started, while Codex has spend in the window', async () => {
    const r = rig();
    r.claude.bill({ at: P0, tokens: TWO });
    utimesSync(join(r.claude.dir, 'fixture-session.jsonl'), new Date(P0 + 2_000), new Date(P0 + 2_000));
    const codex = r.codex.session({ form: 'cache-write', at: P0 });
    r.start({ agents: ['claude-code', 'codex'] });
    codex.bill(T0 + 1_000, ONE);

    await expectWholeRunUnavailable(r);
  });

  it.skipIf(!provokable)('an unreadable Codex file counts as this worktree\'s, so the per-step rule decides instead (host only)', async () => {
    const r = rig();
    r.codex.session({ form: 'cache-write', at: P0, cwd: join(r.worktree, '..', 'another-worktree') });
    const broken = r.codex.session({ form: 'cache-write', at: P0 });
    const born = createdAt(broken.file);
    const start = born - 20_000;
    r.start({ at: start, agents: ['claude-code', 'codex'] });
    r.bill(start + 1_000, ONE);
    r.advance(born - 10_000);
    r.logs.makeUnreadable(broken.file);
    r.setNow(modifiedAt(broken.file) + 1_000);
    const meter = r.meterOn(true);
    meter.withTokens(r.worktree, r.state());

    expect(await shown(r, meter)).toEqual({ steps: [counted(ONE), U, null], counting: 1, run: incomplete(counted(ONE).kinds) });
  });
});

describe.skipIf(!provokable)('a folder that could hold this worktree\'s logs and cannot be listed makes the whole run unavailable (host only)', () => {
  it('a folder inside the worktree\'s Claude Code log folder', async () => {
    const r = rig();
    r.start();
    r.bill(T0 + 1_000, ONE);
    r.claude.bill({ at: T0 + 2_000, tokens: TWO, subagent: 'reviewer-1' });
    r.logs.makeUnreadable(join(r.claude.dir, 'fixture-session', 'subagents'));

    await expectWholeRunUnavailable(r);
  });

  it('a folder inside Codex\'s shared log folder', async () => {
    const r = rig();
    const codex = r.codex.session({ form: 'cache-write', at: P0 });
    r.start({ agents: ['codex'] });
    codex.bill(T0 + 1_000, ONE);
    r.logs.makeUnreadable(dirname(codex.file));

    await expectWholeRunUnavailable(r);
  });

  it('another project\'s Claude Code log folder that cannot be listed changes no count', async () => {
    const r = rig();
    const another = join(r.claudeConfigRoot, 'projects', '-another-project');
    mkdirSync(another, { recursive: true });
    writeFileSync(join(another, 'session.jsonl'), '');
    r.start();
    r.bill(T0 + 1_000, ONE);
    r.logs.makeUnreadable(another);
    const meter = r.meterOn(true);
    meter.withTokens(r.worktree, r.state());

    expect(await shown(r, meter)).toEqual({ steps: [counted(ONE), null, null], counting: 0, run: whole(counted(ONE).kinds) });
  });
});
