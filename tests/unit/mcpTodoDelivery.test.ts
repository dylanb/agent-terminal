import { expect, it } from 'vitest';
import { createSessionTurns } from '../../src/main/mcpSessionTurns';

it('holds accepted text until its turn stops and the terminal is idle, and refuses a second send', () => {
  const delivered: string[] = [];
  const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }) });
  const delivery = turns;
  const hook = (hook_event_name: string, extra = {}) => turns.hook(9, { hook_event_name, transcript_path: '/transcript', ...extra });
  hook('SessionStart', { source: 'startup' });
  hook('UserPromptSubmit', { prompt_id: 'first', prompt: 'send' });
  expect(delivery.acceptSend(9, { id: 'one', text: 'accepted text' })).toBe(null);
  expect(delivery.acceptSend(9, { id: 'two', text: 'refused text' })).toContain('one');
  delivery.deliverPending(true, text => delivered.push(text));
  expect(delivered).toEqual([]);
  hook('Stop');
  delivery.deliverPending(false, text => delivered.push(text));
  expect(delivered).toEqual([]);
  delivery.deliverPending(true, text => delivered.push(text));
  delivery.deliverPending(true, text => delivered.push(text));
  expect(delivered).toEqual(['accepted text']);
});
