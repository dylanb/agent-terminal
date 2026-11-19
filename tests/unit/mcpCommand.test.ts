import { expect, it } from 'vitest';
import { parseMcpCommand } from '../../src/main/mcpTools';

it('decodes commands without manufacturing fields belonging to another action', () => {
  expect(parseMcpCommand('todo_edit', { window: 'w', repo: '/repo', todo: 'one', text: 'edited' })).toEqual({
    ok: true, command: { tool: 'todo_edit', args: { window: 'w', repo: '/repo', todo: 'one', text: 'edited' } },
  });
  expect(parseMcpCommand('approve', { window: 'w', repo: '/repo', step: 'work', turn: null })).toMatchObject({ ok: true, command: { args: { turn: null } } });
});

it('refuses arguments that belong to another command before they reach an operation', () => {
  expect(parseMcpCommand('todo_delete', { window: 'w', repo: '/repo', todo: 'one', text: 'extra' })).toMatchObject({ ok: false });
  expect(parseMcpCommand('terminate', { window: 'w', repo: '/repo', expectedTodoCount: '2' })).toMatchObject({ ok: false });
});
