import { describe, expect, it, onTestFinished } from 'vitest';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import type { FlowTokensView } from '../../src/shared/ipc';
import type { BilledTokens } from '../helpers/agentUsageLogs';
import { createTokenRun } from '../helpers/tokenRun';

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
const NOT_REPORTED: Cell = { reported: 'none' };
const runOf = (step: StepCounts): FlowTokensView['run'] => ({ state: 'counted', someStepsUnavailable: false, kinds: step.kinds });

const T0 = Date.parse('2026-06-27T10:00:00.640Z');

describe('a Codex step counts every billed call in its window, each once', () => {
  // Work 40,000 / 3,000 / 120 / 900, a reviewer subagent 20,000 / 1,500 / 60 / 450, the consolidator
  // 10,000 / 700 / 30 / 210, the conversation 5,000 / 200 / 15 / 80 and a retry 8,000 / 400 / 25 / 160.
  const SUM: BilledTokens = { cacheRead: 83_000, cacheWrite: 5_800, input: 250, output: 1_800 };

  it('sums the work turn, a reviewer subagent\'s own file, the consolidator, the conversation and a retry, counting uncached input apart from the cache reads and writes inside Codex\'s input figure', async () => {
    const run = createTokenRun(onTestFinished, T0);
    const main = run.codex.session({ form: 'cache-write', at: T0 - 120_000 });
    main.bill(T0 - 60_000, { cacheRead: 700_000, cacheWrite: 90_000, input: 5_000, output: 6_000 });
    run.start('red', T0);
    run.host('codex', T0);
    main.bill(T0 + 1_000, { cacheRead: 40_000, cacheWrite: 3_000, input: 120, output: 900 });
    main.reemit(T0 + 1_500);
    const reviewer = run.codex.session({ form: 'cache-write', at: T0 + 1_800 });
    reviewer.bill(T0 + 2_000, { cacheRead: 20_000, cacheWrite: 1_500, input: 60, output: 450 });
    main.bill(T0 + 3_000, { cacheRead: 10_000, cacheWrite: 700, input: 30, output: 210 });
    main.bill(T0 + 4_000, { cacheRead: 5_000, cacheWrite: 200, input: 15, output: 80 });
    main.reemit(T0 + 4_500);
    main.bill(T0 + 5_000, { cacheRead: 8_000, cacheWrite: 400, input: 25, output: 160 });

    expect(await run.tokens(['red', 'done'])).toEqual({ steps: [counted(SUM), null], counting: 0, run: runOf(counted(SUM)) });
  });

  it('an earlier Codex, which logs no cache-write figure, counts the same calls with cache writes not reported', async () => {
    const run = createTokenRun(onTestFinished, T0);
    const main = run.codex.session({ form: 'no-cache-write', at: T0 - 120_000 });
    main.bill(T0 - 60_000, { cacheRead: 700_000, input: 5_000, output: 6_000 });
    run.start('red', T0);
    run.host('codex', T0);
    main.bill(T0 + 1_000, { cacheRead: 40_000, input: 120, output: 900 });
    main.reemit(T0 + 1_500);
    const reviewer = run.codex.session({ form: 'no-cache-write', at: T0 + 1_800 });
    reviewer.bill(T0 + 2_000, { cacheRead: 20_000, input: 60, output: 450 });
    main.bill(T0 + 3_000, { cacheRead: 10_000, input: 30, output: 210 });
    main.bill(T0 + 4_000, { cacheRead: 5_000, input: 15, output: 80 });
    main.bill(T0 + 5_000, { cacheRead: 8_000, input: 25, output: 160 });

    const step = withCacheWrite(counted({ ...SUM, cacheWrite: 0 }), NOT_REPORTED);
    expect(await run.tokens(['red'])).toEqual({ steps: [step], counting: 0, run: runOf(step) });
  });

  it('counts only the calls in a rollout that also holds response, turn context and rate-limit records, a token count with no usage and a half-written last line', async () => {
    const run = createTokenRun(onTestFinished, T0);
    const main = run.codex.session({ form: 'cache-write', at: T0 - 1_000 });
    run.start('red', T0);
    run.host('codex', T0);
    main.bill(T0 + 1_000, { cacheRead: 40_000, cacheWrite: 3_000, input: 120, output: 900 });
    const timestamp = new Date(T0 + 1_500).toISOString();
    const records = [
      { timestamp, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
      { timestamp, type: 'turn_context', payload: { cwd: run.worktree, model: 'gpt' } },
      { timestamp, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: {} } },
      { timestamp, type: 'event_msg', payload: { type: 'agent_message', message: 'done' } },
    ].map((r) => JSON.stringify(r));
    appendFileSync(main.file, `${records.join('\n')}\nnot json\n`);
    main.bill(T0 + 2_000, { cacheRead: 20_000, cacheWrite: 1_500, input: 60, output: 450 });
    appendFileSync(main.file, '{"timestamp":"2026-06-27T10:00:03.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":');

    expect((await run.tokens(['red'])).steps).toEqual([counted({ cacheRead: 60_000, cacheWrite: 4_500, input: 180, output: 1_350 })]);
  });

  it('skips a running total with a figure that is not a whole count and measures the next call from the last good total', async () => {
    const run = createTokenRun(onTestFinished, T0);
    const main = run.codex.session({ form: 'cache-write', at: T0 - 1_000 });
    run.start('red', T0);
    run.host('codex', T0);
    main.bill(T0 + 1_000, { cacheRead: 40_000, cacheWrite: 3_000, input: 120, output: 900 });
    const odd = { input_tokens: 43_120, cached_input_tokens: 40_000, cache_write_input_tokens: 3_000, output_tokens: 1_000_900.5, reasoning_output_tokens: 0, total_tokens: 1_044_020.5 };
    const timestamp = new Date(T0 + 1_500).toISOString();
    appendFileSync(main.file, `${JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: odd, last_token_usage: odd } } })}\n`);
    main.bill(T0 + 2_000, { cacheRead: 20_000, cacheWrite: 1_500, input: 60, output: 450 });

    expect((await run.tokens(['red'])).steps).toEqual([counted({ cacheRead: 60_000, cacheWrite: 4_500, input: 180, output: 1_350 })]);
  });

  it('leaves out a rollout file another worktree\'s session wrote, and a readable one that names no working directory', async () => {
    const run = createTokenRun(onTestFinished, T0);
    const own = run.codex.session({ form: 'cache-write', at: T0 - 1_000 });
    const foreign = run.codex.session({ form: 'cache-write', at: T0 - 1_000, cwd: join(run.worktree, '..', 'another-worktree') });
    const unplaced = run.codex.session({ form: 'cache-write', at: T0 - 1_000, cwd: null });
    run.start('red', T0);
    run.host('codex', T0);
    own.bill(T0 + 1_000, { cacheRead: 6_600, cacheWrite: 440, input: 33, output: 77 });
    foreign.bill(T0 + 2_000, { cacheRead: 900_000, cacheWrite: 80_000, input: 7_000, output: 6_000 });
    unplaced.bill(T0 + 3_000, { cacheRead: 500_000, cacheWrite: 40_000, input: 3_000, output: 2_000 });

    expect((await run.tokens(['red'])).steps).toEqual([counted({ cacheRead: 6_600, cacheWrite: 440, input: 33, output: 77 })]);
  });

  it('a session running across a step change puts each call in the window it was billed in', async () => {
    const run = createTokenRun(onTestFinished, T0);
    const main = run.codex.session({ form: 'cache-write', at: T0 - 1_000 });
    run.start('plan', T0);
    run.host('codex', T0);
    main.bill(T0 + 1_000, { cacheRead: 2_100, cacheWrite: 330, input: 13, output: 52 });
    run.move('advance', { status: 'in_progress', stepName: 'plan' }, { status: 'in_progress', stepName: 'build' }, T0 + 2_000);
    main.reemit(T0 + 2_500);
    main.bill(T0 + 3_000, { cacheRead: 7_700, cacheWrite: 880, input: 19, output: 61 });

    expect((await run.tokens(['plan', 'build'])).steps).toEqual([
      counted({ cacheRead: 2_100, cacheWrite: 330, input: 13, output: 52 }),
      counted({ cacheRead: 7_700, cacheWrite: 880, input: 19, output: 61 }),
    ]);
  });
});

describe('a step hosting Claude Code then an earlier Codex', () => {
  it('sums both agents, its cache-write cell showing Claude Code\'s figure partly reported, and so does the run total', async () => {
    const run = createTokenRun(onTestFinished, T0);
    const codex = run.codex.session({ form: 'no-cache-write', at: T0 + 2_000 });
    run.start('three', T0);
    run.host('claude-code', T0 + 500);
    run.claude.bill({ at: T0 + 1_000, tokens: { cacheRead: 5_000, cacheWrite: 400, input: 60, output: 80 } });
    run.host('codex', T0 + 2_000);
    codex.bill(T0 + 3_000, { cacheRead: 3_000, input: 25, output: 70 });

    const step = withCacheWrite(counted({ cacheRead: 8_000, cacheWrite: 0, input: 85, output: 150 }), { reported: 'some', n: 400 });
    expect(await run.tokens(['three'])).toEqual({ steps: [step], counting: 0, run: runOf(step) });
  });
});

describe('only the logs of the agents that ran are read', () => {
  it('a run that hosted only Codex counts none of the worktree\'s Claude Code spend', async () => {
    const run = createTokenRun(onTestFinished, T0);
    const codex = run.codex.session({ form: 'cache-write', at: T0 - 1_000 });
    run.start('red', T0);
    run.host('codex', T0);
    codex.bill(T0 + 1_000, { cacheRead: 4_400, cacheWrite: 330, input: 22, output: 66 });
    run.claude.bill({ at: T0 + 2_000, tokens: { cacheRead: 900_000, cacheWrite: 80_000, input: 7_000, output: 6_000 } });

    expect((await run.tokens(['red'])).steps).toEqual([counted({ cacheRead: 4_400, cacheWrite: 330, input: 22, output: 66 })]);
  });

  it('a run that hosted only Claude Code counts none of the worktree\'s Codex spend', async () => {
    const run = createTokenRun(onTestFinished, T0);
    const codex = run.codex.session({ form: 'cache-write', at: T0 - 1_000 });
    run.start('red', T0);
    run.host('claude-code', T0);
    run.claude.bill({ at: T0 + 1_000, tokens: { cacheRead: 3_300, cacheWrite: 440, input: 55, output: 66 } });
    codex.bill(T0 + 2_000, { cacheRead: 900_000, cacheWrite: 80_000, input: 7_000, output: 6_000 });

    expect((await run.tokens(['red'])).steps).toEqual([counted({ cacheRead: 3_300, cacheWrite: 440, input: 55, output: 66 })]);
  });

  it('a Claude-Code-only run on a machine with no Codex folder shows its numbers', async () => {
    const run = createTokenRun(onTestFinished, T0, { codexHome: (dir) => join(dir, 'no-codex-here') });
    run.start('red', T0);
    run.host('claude-code', T0);
    run.claude.bill({ at: T0 + 1_000, tokens: { cacheRead: 1_900, cacheWrite: 210, input: 17, output: 43 } });

    expect((await run.tokens(['red'])).steps).toEqual([counted({ cacheRead: 1_900, cacheWrite: 210, input: 17, output: 43 })]);
  });
});
