import { expect, it } from 'vitest';
import { createSessionTurns } from '../../src/main/mcpSessionTurns';
import { hookInput, type HookSession } from '../helpers/fakeClaude';

function pending() {
  const turns = createSessionTurns({ launchOf: async () => ({ print: false, launchPrompt: false }) });
  const session: HookSession = { sessionId: 'caller', transcriptPath: '/transcript', cwd: '/repo' };
  const delivered: string[] = [];
  const deliver = (idle: boolean) => turns.deliverPending(idle, text => delivered.push(text));
  turns.hook(9, hookInput.sessionStart(session, 'startup'));
  turns.hook(9, hookInput.userPromptSubmit(session, 'calling-turn', 'send the todo'));
  expect(turns.acceptSend(9, { id: 'accepted', text: 'retained todo text' })).toBe(null);
  deliver(false);
  turns.hook(9, hookInput.stop(session));
  deliver(false);
  expect(delivered).toEqual([]);
  return { turns, session, delivered, deliver };
}

it('drops the accepted send when a new prompt starts before idle, including after that newer turn stops', () => {
  const f = pending();
  f.turns.hook(9, hookInput.userPromptSubmit(f.session, 'newer-turn', 'operator interruption'));
  f.deliver(true);
  f.turns.hook(9, hookInput.stop(f.session));
  f.deliver(true);
  expect(f.delivered).toEqual([]);
});

it('an app injection before idle cancels the pending send even before its prompt hook arrives', () => {
  const f = pending();
  f.turns.injected('next loop step', { submitted: true });
  f.deliver(true);
  expect(f.delivered).toEqual([]);
});

it.each(['prompt_input_exit', 'clear'] as const)('session end (%s) drops the accepted send before idle', reason => {
  const f = pending();
  f.turns.hook(9, hookInput.sessionEnd(f.session, reason));
  f.deliver(true);
  expect(f.delivered).toEqual([]);
});

it('a new session reusing the same process id cannot receive the old session’s pending send', () => {
  const f = pending();
  f.turns.hook(9, hookInput.sessionStart({ ...f.session, sessionId: 'replacement' }, 'startup'));
  f.deliver(true);
  expect(f.delivered).toEqual([]);
});

it('an uninterrupted pending send still delivers exactly once at idle', () => {
  const f = pending();
  f.deliver(true);
  f.deliver(true);
  expect(f.delivered).toEqual(['retained todo text']);
});
