import { describe, expect, it, onTestFinished } from 'vitest';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createLogCursors, sweepAgentUsage, type AgentLogRoots } from '../../src/main/agentUsage/sweep';
import { agentWorkingDir } from '../../src/main/agentUsage/logRoots';
import { claudeCodeLogs, claudeCodeUsageLine, codexLogs, logsTempDir, type BilledTokens } from '../helpers/agentUsageLogs';

// A sweep that keeps its place in each log between refreshes, as the meter does every 2 s, must count exactly what a
// fresh read of the same logs counts.

const T0 = Date.parse('2026-06-28T09:00:00.310Z');
const A: BilledTokens = { cacheRead: 21_000, cacheWrite: 1_300, input: 70, output: 410 };
const B: BilledTokens = { cacheRead: 5_500, cacheWrite: 260, input: 12, output: 95 };

function rig() {
  const { dir } = logsTempDir('sweep-cursors-', onTestFinished);
  const worktree = join(dir, 'repo');
  mkdirSync(worktree);
  const roots: AgentLogRoots = { claudeConfigRoot: join(dir, 'claude'), codexHome: join(dir, 'codex') };
  const total = async (cursors?: ReturnType<typeof createLogCursors>, agents: ('claude-code' | 'codex')[] = ['claude-code']) => {
    const { calls, problems } = await sweepAgentUsage(roots, worktree, agents, T0, cursors);
    const sum = { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 };
    for (const c of calls) for (const k of Object.keys(sum) as (keyof BilledTokens)[]) sum[k] += c.kinds[k] ?? 0;
    return { calls: calls.length, sum, problems };
  };
  return { worktree, roots, claude: claudeCodeLogs(roots.claudeConfigRoot!, worktree), codex: codexLogs(roots.codexHome!, worktree), total };
}

const plus = (x: BilledTokens, y: BilledTokens): BilledTokens => ({
  cacheRead: x.cacheRead + y.cacheRead,
  cacheWrite: x.cacheWrite + y.cacheWrite,
  input: x.input + y.input,
  output: x.output + y.output,
});

describe('a sweep that keeps its place in each log', () => {
  it('counts a call appended after the last sweep once, and every earlier call once', async () => {
    const r = rig();
    const cursors = createLogCursors();
    r.claude.bill({ at: T0 + 1_000, tokens: A });
    await r.total(cursors);
    r.claude.bill({ at: T0 + 2_000, tokens: B });

    expect(await r.total(cursors)).toEqual(await r.total());
    expect((await r.total(cursors)).sum).toEqual(plus(A, B));
  });

  it('counts a line left half written at one sweep once it is complete at the next', async () => {
    const r = rig();
    const cursors = createLogCursors();
    r.claude.bill({ at: T0 + 1_000, tokens: A });
    const file = join(r.claude.dir, 'fixture-session.jsonl');
    const line = `${claudeCodeUsageLine({ id: 'half', timestamp: new Date(T0 + 2_000).toISOString(), tokens: B, sessionId: 'fixture-session', cwd: agentWorkingDir(r.worktree), block: 0 })}\n`;
    appendFileSync(file, line.slice(0, 40));
    expect((await r.total(cursors)).sum).toEqual(A);
    appendFileSync(file, line.slice(40));

    expect((await r.total(cursors)).sum).toEqual(plus(A, B));
  });

  it('starts a log over when it is replaced by a shorter one', async () => {
    const r = rig();
    const cursors = createLogCursors();
    r.claude.bill({ at: T0 + 1_000, tokens: A });
    r.claude.bill({ at: T0 + 2_000, tokens: A });
    await r.total(cursors);
    writeFileSync(join(r.claude.dir, 'fixture-session.jsonl'), '');
    r.claude.bill({ at: T0 + 3_000, tokens: B });

    expect((await r.total(cursors)).sum).toEqual(B);
  });

  it('measures a Codex call from the total before it when that total was read at an earlier sweep', async () => {
    const r = rig();
    const cursors = createLogCursors();
    const session = r.codex.session({ form: 'cache-write', at: T0 - 1_000 });
    session.bill(T0 + 1_000, A);
    await r.total(cursors, ['codex']);
    session.bill(T0 + 2_000, B);

    expect((await r.total(cursors, ['codex'])).sum).toEqual(plus(A, B));
  });

  it('leaves out another worktree\'s Codex rollout read across sweeps', async () => {
    const r = rig();
    const cursors = createLogCursors();
    r.codex.session({ form: 'cache-write', at: T0 - 1_000 }).bill(T0 + 1_000, A);
    const foreign = r.codex.session({ form: 'cache-write', at: T0 - 1_000, cwd: join(r.worktree, '..', 'elsewhere') });
    foreign.bill(T0 + 1_500, B);
    await r.total(cursors, ['codex']);
    foreign.bill(T0 + 2_000, B);

    expect((await r.total(cursors, ['codex'])).sum).toEqual(A);
  });
});
