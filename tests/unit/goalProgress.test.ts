import { describe, expect, it } from 'vitest';
import { exampleGoalProgress, parseGoalProgress } from '../../src/shared/goalProgress';

// §27.3 (v2.201) — the progress file a goal session keeps: the engine reads its leg and status to decide
// whether the session finished, checkpointed, or is blocked on the operator.

describe('the goal progress file (§27.3 v2.201)', () => {
  it.each([['working'], ['checkpoint'], ['done']] as const)('the example for %s parses to its leg and status', (status) => {
    expect(parseGoalProgress(exampleGoalProgress(2, status))).toEqual({ leg: 2, status, blocked: null });
  });

  it('the blocked example carries what the session needs from the operator', () => {
    const p = parseGoalProgress(exampleGoalProgress(1, 'blocked'));
    expect(p?.status).toBe('blocked');
    expect(p?.blocked).toMatch(/\S/);
  });

  it('reads the fields under any list bullet and among other notes', () => {
    const text = '# Goal progress\n\nSome notes first.\n\n* Leg: 3\n1. Status: checkpoint\n\n## Done so far\n- slice wired\n';
    expect(parseGoalProgress(text)).toEqual({ leg: 3, status: 'checkpoint', blocked: null });
  });

  it.each([
    ['in code spans', '- Leg: `2`\n- Status: `checkpoint`\n', { leg: 2, status: 'checkpoint' }],
    ['with bold labels', '**Leg:** 1\n**Status:** done\n', { leg: 1, status: 'done' }],
    ['in bold values and capitals', 'Leg: **1**\nStatus: **Done**\n', { leg: 1, status: 'done' }],
    ['with a full stop', 'Leg: 2.\nStatus: done.\n', { leg: 2, status: 'done' }],
    ['with a note after the status', 'Leg: 1\nStatus: checkpoint (3 passes run)\n', { leg: 1, status: 'checkpoint' }],
    ['with punctuation outside the markup', 'Leg: `2`.\nStatus: `done`.\n', { leg: 2, status: 'done' }],
    ['in bold with a full stop', 'Leg: **2**.\nStatus: done\n', { leg: 2, status: 'done' }],
    ['with a note after the leg', 'Leg: 2 (of 3)\nStatus: done\n', { leg: 2, status: 'done' }],
  ])('reads the fields written %s', (_how, text, want) => {
    expect(parseGoalProgress(text)).toEqual({ ...want, blocked: null });
  });

  it.each([
    ['## Blocked:', 'Modal or page?'],
    ['## Blocked on the operator', 'on the operator\nModal or page?'],
  ])('reads the blocked section under %j', (heading, want) => {
    expect(parseGoalProgress(`Leg: 1\nStatus: blocked\n\n${heading}\nModal or page?\n`)?.blocked).toBe(want);
  });

  it.each([
    ['a fenced code block', '```sh\n# wipes local data\npnpm db:reset\n```'],
    ['a tilde-fenced code block', '~~~\n# wipes local data\n~~~'],
    ['an indented code block', '    # wipes local data'],
    ['a tab-indented code block', '\t# wipes local data\n\tmake db-reset'],
    ['a fence holding a line that only looks like a fence', '```\n```ts\n# wipes local data\n```'],
  ])('keeps a # line inside %s in the blocked reason', (_what, code) => {
    const text = `Leg: 1\nStatus: blocked\n\n## Blocked\nRun this?\n${code}\nOr mock the store?\n\n## Next\n- wait\n`;
    expect(parseGoalProgress(text)?.blocked).toBe(`Run this?\n${code}\nOr mock the store?`);
  });

  it('ends the blocked reason at the next heading after a line that opens with an inline code span', () => {
    const text = 'Leg: 1\nStatus: blocked\n\n## Blocked\n```pnpm db:reset``` wipes local data. Run it?\n\n## Next\n- wait\n';
    expect(parseGoalProgress(text)?.blocked).toBe('```pnpm db:reset``` wipes local data. Run it?');
  });

  it('reads a blocked reason that opens with an issue reference', () => {
    expect(parseGoalProgress('Leg: 1\nStatus: blocked\n\n## Blocked\n#208 asks for a modal and a page. Which?\n')?.blocked).toBe('#208 asks for a modal and a page. Which?');
  });

  it('reads a blocked reason written on the heading line, and keeps it ahead of the lines below', () => {
    expect(parseGoalProgress('Leg: 1\nStatus: blocked\n\n## Blocked: Modal or page?\n')?.blocked).toBe('Modal or page?');
    expect(parseGoalProgress('Leg: 1\nStatus: blocked\n\n## Blocked on the API contract\nWhich version?\n')?.blocked).toBe('on the API contract\nWhich version?');
  });

  it('returns the blocked section text as the reason', () => {
    const text = 'Leg: 1\nStatus: blocked\n\n## Blocked\nThe plan says both A and B.\nPick one.\n\n## Next\n- wait\n';
    expect(parseGoalProgress(text)?.blocked).toBe('The plan says both A and B.\nPick one.');
  });

  it.each([
    ['no leg', 'Status: done\n'],
    ['no status', 'Leg: 1\n'],
    ['a leg that is not a positive whole number', 'Leg: 0\nStatus: done\n'],
    ['a fractional leg', 'Leg: 1.5\nStatus: done\n'],
    ['an unknown status', 'Leg: 1\nStatus: finished\n'],
    ['an unknown status in a code span', 'Leg: 1\nStatus: `finished`\n'],
    ['a status that is not the first word', 'Leg: 1\nStatus: not done\n'],
    ['blocked with nothing under Blocked', 'Leg: 1\nStatus: blocked\n\n## Blocked\n\n## Next\n'],
    ['blocked with no Blocked section', 'Leg: 1\nStatus: blocked\n'],
  ])('is not well-formed with %s', (_what, text) => {
    expect(parseGoalProgress(text)).toBeNull();
  });
});
