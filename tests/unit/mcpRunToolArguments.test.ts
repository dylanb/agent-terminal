import { describe, expect, it } from 'vitest';
import { invalidToolArguments } from '../../src/main/mcpTools';

const own = { window: 'window', repo: '/repo' };
describe('run tool arguments', () => {
  it('accepts step approval, typed entry inputs and a termination count', () => {
    expect([
      invalidToolArguments('approve', { ...own, step: 'plan', inputs: { ticket: '322' } }),
      invalidToolArguments('start', { ...own, inputs: { ticket: '322' } }),
      invalidToolArguments('terminate', { ...own, expectedTodoCount: 0 }),
    ]).toEqual([null, null, null]);
  });
  it.each([null, [], '322', { ticket: 322 }])('rejects malformed inputs %j', inputs => {
    expect(invalidToolArguments('start', { ...own, inputs })).toMatch(/inputs/);
  });
  it.each([-1, 0.5, '1', null, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid termination count %j', expectedTodoCount => {
    expect(invalidToolArguments('terminate', { ...own, expectedTodoCount })).toMatch(/expectedTodoCount/);
  });
});
