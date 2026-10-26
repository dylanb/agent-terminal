import { describe, expect, it } from 'vitest';
import { exampleGoalProgress, GOAL_PROGRESS_STATUSES, goalLegEnd, parseGoalProgress, readGoalProgress } from '../../src/shared/goalProgress';

// §27.3 — a goal session records the state the engine acts on as JSON, and keeps its own notes apart.
// The engine reads the leg, the status and, when blocked, what the session needs from the operator.

describe('the goal progress the engine reads (§27.3)', () => {
  it.each(GOAL_PROGRESS_STATUSES)('the %s example is well-formed and reads back as itself', (status) => {
    expect(parseGoalProgress(exampleGoalProgress(3, status))).toMatchObject({ leg: 3, status });
  });

  it('the blocked example carries what the session needs from the operator', () => {
    expect(parseGoalProgress(exampleGoalProgress(1, 'blocked'))?.blocked).toMatch(/\S/);
  });

  it('reads the blocked reason as written, whatever Markdown it holds', () => {
    const blocked = '## Question\nModal or page?\n```sh\n# wipes local data\n```\n#208 asks for both.';
    expect(parseGoalProgress(JSON.stringify({ leg: 1, status: 'blocked', blocked }))?.blocked).toBe(blocked);
  });

  it('ignores the blocked reason unless the session is blocked, and fields it does not know', () => {
    expect(parseGoalProgress(JSON.stringify({ leg: 2, status: 'done', blocked: 'old', notes: 'x' }))).toEqual({ leg: 2, status: 'done', blocked: null });
  });

  it('reads a file with a byte order mark or surrounding whitespace', () => {
    expect(parseGoalProgress(`﻿\n  ${JSON.stringify({ leg: 1, status: 'working' })}\n\n`)).toEqual({ leg: 1, status: 'working', blocked: null });
  });

  it.each([
    ['not JSON', '- Leg: 1\n- Status: done\n', /not valid JSON/],
    ['not an object', '[1, "done"]', /not a JSON object/],
    ['no leg', '{"status":"done"}', /leg/],
    ['a leg that is not a positive whole number', '{"leg":0,"status":"done"}', /leg/],
    ['a fractional leg', '{"leg":1.5,"status":"done"}', /leg/],
    ['a leg written as text', '{"leg":"1","status":"done"}', /leg/],
    ['an unknown status', '{"leg":1,"status":"finished"}', /status/],
    ['blocked with no reason', '{"leg":1,"status":"blocked"}', /blocked/],
    ['blocked with a blank reason', '{"leg":1,"status":"blocked","blocked":"  "}', /blocked/],
  ])('is not well-formed with %s, and says what is wrong', (_what, text, problem) => {
    expect(parseGoalProgress(text)).toBeNull();
    const read = readGoalProgress(text);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problem).toMatch(problem);
  });

  it('never repeats the file text in what it says is wrong', () => {
    const read = readGoalProgress('{"leg": 1, "status": "do\u001b[31mne <script>"');
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problem).not.toContain('script');
  });
});

describe('whether a progress file ends this leg (§27.3)', () => {
  it.each([
    ['done', 2, true],
    ['checkpoint', 2, true],
    ['blocked', 2, false],
  ] as const)('a %s file on this leg ends it', (status, leg, legs) => {
    expect(goalLegEnd(exampleGoalProgress(leg, status), { leg, legs })).toMatchObject({ ok: true, progress: { status } });
  });

  it.each([
    ['another leg', exampleGoalProgress(1, 'done'), { leg: 2, legs: true }, /records leg 1, not this leg \(2\)/],
    ['still working', exampleGoalProgress(2, 'working'), { leg: 2, legs: true }, /still working/],
    ['a checkpoint in a one-leg goal', exampleGoalProgress(1, 'checkpoint'), { leg: 1, legs: false }, /one leg/],
    ['a file that is not JSON', '- Leg: 1', { leg: 1, legs: true }, /not valid JSON/],
  ])('does not end it with %s, and says why', (_what, text, at, why) => {
    const end = goalLegEnd(text, at);
    expect(end.ok).toBe(false);
    if (!end.ok) expect(end.problem).toMatch(why);
  });
});
