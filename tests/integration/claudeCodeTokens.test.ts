import { describe, expect, it, onTestFinished } from 'vitest';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlowTokensView } from '../../src/shared/ipc';
import type { BilledTokens } from '../helpers/agentUsageLogs';
import { createTokenRun } from '../helpers/tokenRun';

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

const T0 = Date.parse('2026-06-23T10:00:00.400Z');
const at = (iso: string): number => Date.parse(iso);

describe('a Claude Code step counts every billed call in its window, each once', () => {
  it('sums the work turn, a reviewer subagent, the consolidator, the conversation and a retry, and leaves out spend from before the start', async () => {
    const run = createTokenRun(onTestFinished, T0);
    run.claude.bill({ at: T0 - 60_000, tokens: { cacheRead: 700_000, cacheWrite: 90_000, input: 5_000, output: 6_000 } });
    run.start('red', T0);
    run.host('claude-code', T0);
    const work = run.claude.bill({ at: T0 + 1_000, tokens: { cacheRead: 40_000, cacheWrite: 3_000, input: 120, output: 900 }, lines: 3 });
    run.claude.bill({ at: T0 + 2_000, tokens: { cacheRead: 20_000, cacheWrite: 1_500, input: 60, output: 450 }, subagent: 'reviewer-1' });
    run.claude.bill({ at: T0 + 3_000, tokens: { cacheRead: 10_000, cacheWrite: 700, input: 30, output: 210 } });
    run.claude.bill({ at: T0 + 4_000, tokens: { cacheRead: 5_000, cacheWrite: 200, input: 15, output: 80 } });
    run.claude.bill({ at: T0 + 5_000, tokens: { cacheRead: 8_000, cacheWrite: 400, input: 25, output: 160 } });
    run.claude.bill({ at: T0 + 1_000, tokens: { cacheRead: 40_000, cacheWrite: 3_000, input: 120, output: 900 }, id: work, session: 'resumed-session' });

    expect(await run.tokens(['red', 'done'])).toEqual({
      steps: [counted({ cacheRead: 83_000, cacheWrite: 5_800, input: 250, output: 1_800 }), null],
      counting: 0,
      run: runOf({ cacheRead: 83_000, cacheWrite: 5_800, input: 250, output: 1_800 }),
    });
  });

  it('counts only the billed calls in a log that also holds user, summary and tool lines, a call with no usage or no readable time, a line that is not JSON and a half-written last line', async () => {
    const run = createTokenRun(onTestFinished, T0);
    run.start('red', T0);
    run.host('claude-code', T0);
    const BILLED = { cacheRead: 40_000, cacheWrite: 3_000, input: 120, output: 900 };
    const billed = run.claude.bill({ at: T0 + 1_000, tokens: BILLED });
    const when = new Date(T0 + 1_500).toISOString();
    const usage = { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 5, cache_creation_input_tokens: 5 };
    const lines = [
      { type: 'user', message: { role: 'user', content: 'go' }, timestamp: when },
      { type: 'summary', summary: 'earlier work', leafUuid: 'leaf-1' },
      { type: 'assistant', message: { id: 'msg-no-usage', role: 'assistant' }, timestamp: when },
      { type: 'assistant', requestId: `req_fixture_${billed}`, message: { id: `msg_fixture_${billed}`, usage }, timestamp: 'not a time' },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }, timestamp: when },
    ].map((l) => JSON.stringify(l));
    appendFileSync(join(run.claude.dir, 'fixture-session.jsonl'), `${lines.join('\n')}\nnot json at all\n{"type":"assistant","message":{"id":"msg-cut","usage":{"input_tokens":`);

    expect((await run.tokens(['red'])).steps).toEqual([counted(BILLED)]);
  });

  it('reads a figure that is not a whole count as not reported for that call, so the step\'s figure of that kind is partly reported', async () => {
    const run = createTokenRun(onTestFinished, T0);
    run.start('red', T0);
    run.host('claude-code', T0);
    run.claude.bill({ at: T0 + 1_000, tokens: { cacheRead: 40_000, cacheWrite: 3_000, input: 120, output: 900 } });
    run.claude.bill({ at: T0 + 2_000, tokens: { cacheRead: 9_000, cacheWrite: 500, input: 7, output: 410.5 } });

    expect((await run.tokens(['red'])).steps).toEqual([
      {
        state: 'counted',
        billed: true,
        kinds: {
          cacheRead: { reported: 'all', n: 49_000 },
          cacheWrite: { reported: 'all', n: 3_500 },
          input: { reported: 'all', n: 127 },
          output: { reported: 'some', n: 900 },
        },
      },
    ]);
  });

  it('counts a streamed call at the largest figure of each kind among its copies, whichever copy the log holds first', async () => {
    const run = createTokenRun(onTestFinished, T0);
    run.start('red', T0);
    run.host('claude-code', T0);
    const growing = run.claude.bill({ at: T0 + 1_000, tokens: { cacheRead: 30_000, cacheWrite: 2_000, input: 40, output: 12 } });
    run.claude.bill({ at: T0 + 1_000, tokens: { cacheRead: 30_000, cacheWrite: 2_000, input: 40, output: 640 }, id: growing });
    const shrinking = run.claude.bill({ at: T0 + 2_000, tokens: { cacheRead: 9_000, cacheWrite: 500, input: 7, output: 530 } });
    run.claude.bill({ at: T0 + 2_000, tokens: { cacheRead: 9_000, cacheWrite: 500, input: 7, output: 9 }, id: shrinking });

    expect((await run.tokens(['red'])).steps).toEqual([counted({ cacheRead: 39_000, cacheWrite: 2_500, input: 47, output: 1_170 })]);
  });

  it('places a streamed call at its earliest copy, so copies on both sides of a step change count once, in the step it began in', async () => {
    const run = createTokenRun(onTestFinished, T0);
    run.start('plan', T0);
    run.host('claude-code', T0);
    const change = at('2026-06-23T10:00:05.600Z');
    run.move('advance', { status: 'in_progress', stepName: 'plan' }, { status: 'in_progress', stepName: 'build' }, change);
    const call = run.claude.bill({ at: change + 100, tokens: { cacheRead: 6_000, cacheWrite: 300, input: 11, output: 420 } });
    run.claude.bill({ at: change - 100, tokens: { cacheRead: 6_000, cacheWrite: 300, input: 11, output: 5 }, id: call });

    expect((await run.tokens(['plan', 'build'])).steps).toEqual([counted({ cacheRead: 6_000, cacheWrite: 300, input: 11, output: 420 }), idle]);
  });

  it('puts a call earlier in the same second as a step change in the step it left, and one later in the step it entered', async () => {
    const run = createTokenRun(onTestFinished, T0);
    run.start('plan', T0);
    run.host('claude-code', T0);
    run.move('advance', { status: 'in_progress', stepName: 'plan' }, { status: 'in_progress', stepName: 'build' }, at('2026-06-23T10:00:05.600Z'));
    run.claude.bill({ at: at('2026-06-23T10:00:05.300Z'), tokens: { cacheRead: 2_100, cacheWrite: 330, input: 13, output: 52 } });
    run.claude.bill({ at: at('2026-06-23T10:00:05.700Z'), tokens: { cacheRead: 7_700, cacheWrite: 880, input: 19, output: 61 } });

    expect((await run.tokens(['plan', 'build'])).steps).toEqual([
      counted({ cacheRead: 2_100, cacheWrite: 330, input: 13, output: 52 }),
      counted({ cacheRead: 7_700, cacheWrite: 880, input: 19, output: 61 }),
    ]);
  });

  it('counts a manual step\'s conversation, shows 0 for an entered step with no spend and no count for a step not entered', async () => {
    const run = createTokenRun(onTestFinished, T0);
    run.start('plan', T0);
    run.host('claude-code', T0);
    run.claude.bill({ at: T0 + 1_000, tokens: { cacheRead: 15_000, cacheWrite: 1_100, input: 90, output: 300 } });
    run.move('advance', { status: 'in_progress', stepName: 'plan' }, { status: 'in_progress', stepName: 'talk' }, T0 + 10_000);
    run.claude.bill({ at: T0 + 11_000, tokens: { cacheRead: 4_400, cacheWrite: 120, input: 35, output: 70 } });
    run.move('advance', { status: 'in_progress', stepName: 'talk' }, { status: 'in_progress', stepName: 'quiet' }, T0 + 20_000);

    expect(await run.tokens(['plan', 'talk', 'quiet', 'ship'])).toEqual({
      steps: [
        counted({ cacheRead: 15_000, cacheWrite: 1_100, input: 90, output: 300 }),
        counted({ cacheRead: 4_400, cacheWrite: 120, input: 35, output: 70 }),
        idle,
        null,
      ],
      counting: 2,
      run: runOf({ cacheRead: 19_400, cacheWrite: 1_220, input: 125, output: 370 }),
    });
  });

  it('counts nothing billed after the flow completes, keeps every count, and marks no step counting', async () => {
    const run = createTokenRun(onTestFinished, T0);
    run.start('plan', T0);
    run.host('claude-code', T0);
    run.claude.bill({ at: T0 + 1_000, tokens: { cacheRead: 3_300, cacheWrite: 440, input: 55, output: 66 } });
    run.move('advance', { status: 'in_progress', stepName: 'plan' }, { status: 'done', stepName: 'plan' }, T0 + 2_000);
    run.claude.bill({ at: T0 + 3_000, tokens: { cacheRead: 990_000, cacheWrite: 88_000, input: 7_700, output: 6_600 } });

    expect(await run.tokens(['plan'])).toEqual({
      steps: [counted({ cacheRead: 3_300, cacheWrite: 440, input: 55, output: 66 })],
      counting: null,
      run: runOf({ cacheRead: 3_300, cacheWrite: 440, input: 55, output: 66 }),
    });
  });
});
