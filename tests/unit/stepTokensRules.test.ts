import { describe, expect, it } from 'vitest';
import { stepTokens, type StepWindow } from '../../src/main/stepTokens';
import type { LogProblem } from '../../src/main/agentUsage/sweep';
import type { FlowTokensView } from '../../src/shared/ipc';

// The per-step and whole-run "unavailable" rules over hand-made windows and sweep problems: the rules that need a
// real unreadable file are proved over real logs in tests/integration/tokenUnavailable.test.ts.

const T = (s: string): number => Date.parse(`2026-06-26T09:${s}Z`);
const iso = (ms: number): string => new Date(ms).toISOString();
const STEPS = ['one', 'two', 'three'];
// one: [00:00, 01:00), two: [01:00, open).
const WINDOWS: StepWindow[] = [
  { step: 'one', entered: iso(T('00:00.000')), exited: iso(T('01:00.000')) },
  { step: 'two', entered: iso(T('01:00.000')), exited: null },
];
const NOW = T('02:00.000');

type StepCounts = Extract<NonNullable<FlowTokensView['steps'][number]>, { state: 'counted' }>;
const ONE_CALL: StepCounts = {
  state: 'counted',
  billed: true,
  kinds: { cacheRead: { reported: 'all', n: 4_100 }, cacheWrite: { reported: 'all', n: 230 }, input: { reported: 'all', n: 17 }, output: { reported: 'all', n: 62 } },
};
const idleKinds = { cacheRead: { reported: 'all', n: 0 }, cacheWrite: { reported: 'all', n: 0 }, input: { reported: 'all', n: 0 }, output: { reported: 'all', n: 0 } } as const;
const CALLS = [{ at: T('00:30.000'), kinds: { cacheRead: 4_100, cacheWrite: 230, input: 17, output: 62 } }];
const UNAVAILABLE = { state: 'unavailable' } as const;

const unreadable = (from: string, to: string): LogProblem => ({ problem: 'unreadable file', span: { from: T(from), to: T(to) } });
const view = (problems: LogProblem[], now = NOW) => stepTokens(WINDOWS, STEPS, { calls: CALLS, problems }, now);

describe('an unreadable file makes unavailable only the entered steps whose windows overlap its span', () => {
  it('a span inside step 2 only: step 2 unavailable, step 1 counted, step 3 a dash, the run total step 1\'s marked incomplete', () => {
    expect(view([unreadable('01:20.000', '01:40.000')])).toEqual({
      steps: [ONE_CALL, UNAVAILABLE, null],
      counting: 1,
      run: { state: 'counted', someStepsUnavailable: true, kinds: ONE_CALL.kinds },
    });
  });

  it('a span that ends exactly when step 1 opens overlaps it, both ends included', () => {
    expect(view([{ problem: 'unreadable file', span: { from: T('00:00.000') - 30_000, to: T('00:00.000') } }]).steps[0]).toEqual(UNAVAILABLE);
  });

  it('a span that starts exactly when step 1 closes overlaps step 1 as well as step 2', () => {
    expect(view([unreadable('01:00.000', '01:10.000')]).steps.slice(0, 2)).toEqual([UNAVAILABLE, UNAVAILABLE]);
  });

  it('an open window ends now: a span starting after now overlaps nothing, one starting at now overlaps it', () => {
    expect([view([unreadable('02:00.001', '02:30.000')]).steps[1], view([unreadable('02:00.000', '02:30.000')]).steps[1]]).toEqual([
      { state: 'counted', billed: false, kinds: { cacheRead: { reported: 'all', n: 0 }, cacheWrite: { reported: 'all', n: 0 }, input: { reported: 'all', n: 0 }, output: { reported: 'all', n: 0 } } },
      UNAVAILABLE,
    ]);
  });

  it('a step entered twice is unavailable when any of its windows overlaps', () => {
    const twice: StepWindow[] = [...WINDOWS.slice(0, 1), { step: 'two', entered: iso(T('01:00.000')), exited: iso(T('01:30.000')) }, { step: 'one', entered: iso(T('01:30.000')), exited: null }];
    expect(stepTokens(twice, STEPS, { calls: CALLS, problems: [unreadable('01:40.000', '01:50.000')] }, NOW).steps[0]).toEqual(UNAVAILABLE);
  });

  it('a step entered twice is unavailable when only its first window overlaps, and the step between is still counted', () => {
    const twice: StepWindow[] = [...WINDOWS.slice(0, 1), { step: 'two', entered: iso(T('01:00.000')), exited: iso(T('01:30.000')) }, { step: 'one', entered: iso(T('01:30.000')), exited: null }];
    const shown = stepTokens(twice, STEPS, { calls: CALLS, problems: [unreadable('00:20.000', '00:40.000')] }, NOW);
    expect(shown.steps.slice(0, 2)).toEqual([UNAVAILABLE, { ...ONE_CALL, billed: false, kinds: idleKinds }]);
  });

  it('a call made at the instant one step closes and the next opens counts in the next step only', () => {
    const atChange = [{ at: T('01:00.000'), kinds: { cacheRead: 4_100, cacheWrite: 230, input: 17, output: 62 } }];
    expect(stepTokens(WINDOWS, STEPS, { calls: atChange, problems: [] }, NOW).steps).toEqual([{ ...ONE_CALL, billed: false, kinds: idleKinds }, ONE_CALL, null]);
  });

  it('a span overlapping no entered window changes no count', () => {
    expect(view([unreadable('03:00.000', '04:00.000')], NOW).run).toEqual({ state: 'counted', someStepsUnavailable: false, kinds: ONE_CALL.kinds });
  });
});

describe('a whole-run problem makes every entered step and the run total unavailable, and leaves a step not entered its dash', () => {
  it.each<[string, LogProblem]>([
    ['an unreadable file whose times cannot be read', { problem: 'unreadable file', span: 'times-unreadable' }],
    ['a folder that counts and cannot be listed', { problem: 'unlistable folder' }],
    ['the log folder of an agent that ran is missing', { problem: 'missing folder', agent: 'codex' }],
    ['no supported agent has logs for the worktree', { problem: 'no logs' }],
    ['an agent that ran has no log file modified since the run started', { problem: 'no log since the start', agent: 'claude-code' }],
  ])('%s', (_case, problem) => {
    expect(view([problem])).toEqual({ steps: [UNAVAILABLE, UNAVAILABLE, null], counting: 1, run: UNAVAILABLE });
  });
});
