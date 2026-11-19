import { expect, it } from 'vitest';
import { createSessionTurns } from '../../src/main/mcpSessionTurns';
import { hookInput } from '../helpers/fakeClaude';

it('permanently drops a send when its caller loses foreground before idle', () => {
  let foreground = true;
  const turns = createSessionTurns({ launchOf: async () => null, recipientOf: () => foreground ? 'caller' : null });
  const session = { sessionId: 'caller', transcriptPath: '/transcript', cwd: '/repo' };
  const delivered: string[] = [];
  turns.hook(9, hookInput.sessionStart(session, 'startup'));
  turns.hook(9, hookInput.userPromptSubmit(session, 'turn', 'send'));
  turns.acceptSend(9, { id: 'todo', text: 'accepted text' });
  foreground = false;
  turns.deliverPending(false, text => delivered.push(text));
  foreground = true;
  turns.hook(9, hookInput.stop(session));
  turns.deliverPending(true, text => delivered.push(text));
  expect(delivered).toEqual([]);
});

it('refuses a second send after cancellation in the same turn, but accepts one in a new turn', () => {
  let foreground = true;
  const turns = createSessionTurns({ launchOf: async () => null, recipientOf: () => foreground ? 'caller' : null });
  const session = { sessionId: 'caller', transcriptPath: '/transcript', cwd: '/repo' };
  const delivered: string[] = [];
  turns.hook(9, hookInput.sessionStart(session, 'startup'));
  turns.hook(9, hookInput.userPromptSubmit(session, 'turn', 'send'));
  expect(turns.acceptSend(9, { id: 'first', text: 'first text' })).toBe(null);
  foreground = false;
  turns.deliverPending(false, text => delivered.push(text));
  foreground = true;
  expect(turns.acceptSend(9, { id: 'second', text: 'second text' })).toEqual(expect.stringMatching(/first/));
  turns.hook(9, hookInput.stop(session));
  turns.deliverPending(true, text => delivered.push(text));
  expect(delivered).toEqual([]);
  turns.hook(9, hookInput.userPromptSubmit(session, 'new-turn', 'try again'));
  expect(turns.acceptSend(9, { id: 'third', text: 'third text' })).toBe(null);
  turns.hook(9, hookInput.stop(session));
  turns.deliverPending(true, text => delivered.push(text));
  expect(delivered).toEqual(['third text']);
});

it('delivers the retained text exactly once when an injection joins the calling turn', () => {
  const turns = createSessionTurns({ launchOf: async () => null });
  const session = { sessionId: 'caller', transcriptPath: '/transcript', cwd: '/repo' };
  const delivered: string[] = [];
  turns.hook(9, hookInput.sessionStart(session, 'startup'));
  turns.hook(9, hookInput.userPromptSubmit(session, 'turn', 'send'));
  expect(turns.acceptSend(9, { id: 'todo', text: 'retained text' })).toBe(null);
  turns.injected('joins the open turn', { submitted: true });
  turns.hook(9, hookInput.userPromptSubmit(session, 'turn', 'joins the open turn'));
  turns.deliverPending(true, text => delivered.push(text));
  expect(delivered).toEqual([]);
  turns.hook(9, hookInput.stop(session));
  turns.deliverPending(true, text => delivered.push(text));
  turns.deliverPending(true, text => delivered.push(text));
  expect(delivered).toEqual(['retained text']);
});

it('refuses an unavailable recipient without persisting status or consuming the turn’s send', () => {
  let recipient: string | null = null;
  let persisted = 0;
  const delivered: string[] = [];
  const turns = createSessionTurns({ launchOf: async () => null, recipientOf: () => recipient });
  const session = { sessionId: 'caller', transcriptPath: '/transcript', cwd: '/repo' };
  turns.hook(9, hookInput.sessionStart(session, 'startup'));
  turns.hook(9, hookInput.userPromptSubmit(session, 'turn', 'send'));
  expect(turns.acceptSend(9, { id: 'todo', text: 'retained text' }, () => { persisted++; })).toEqual(expect.stringMatching(/recipient/));
  expect(persisted).toBe(0);
  recipient = 'original';
  expect(turns.acceptSend(9, { id: 'todo', text: 'retained text' }, () => { persisted++; })).toBe(null);
  expect(persisted).toBe(1);
  turns.hook(9, hookInput.stop(session));
  turns.deliverPending(true, text => delivered.push(text));
  expect(delivered).toEqual(['retained text']);
});

it('permanently cancels on a different non-null recipient even when the original returns', () => {
  let recipient = 'original';
  const delivered: string[] = [];
  const turns = createSessionTurns({ launchOf: async () => null, recipientOf: () => recipient });
  const session = { sessionId: 'caller', transcriptPath: '/transcript', cwd: '/repo' };
  turns.hook(9, hookInput.sessionStart(session, 'startup'));
  turns.hook(9, hookInput.userPromptSubmit(session, 'turn', 'send'));
  expect(turns.acceptSend(9, { id: 'todo', text: 'retained text' })).toBe(null);
  recipient = 'replacement';
  turns.cancelInterruptedSends();
  recipient = 'original';
  turns.hook(9, hookInput.stop(session));
  turns.deliverPending(true, text => delivered.push(text));
  expect(delivered).toEqual([]);
});

it('permanently cancels an in-flight delivery when foreground is lost before submission', () => {
  let foreground = true;
  const turns = createSessionTurns({ launchOf: async () => null, recipientOf: () => foreground ? 'caller' : null });
  const session = { sessionId: 'caller', transcriptPath: '/transcript', cwd: '/repo' };
  turns.hook(9, hookInput.sessionStart(session, 'startup'));
  turns.hook(9, hookInput.userPromptSubmit(session, 'turn', 'send'));
  expect(turns.acceptSend(9, { id: 'todo', text: 'retained' })).toBe(null);
  turns.hook(9, hookInput.stop(session));
  let canReceive: (() => boolean) | undefined;
  turns.deliverPending(true, (_text, _id, _identity, _tmux, delivery) => { canReceive = delivery?.canReceive; });
  expect(canReceive?.()).toBe(true);
  turns.injected('retained', { submitted: true, sendingSession: 9 });
  expect(canReceive?.()).toBe(true);
  foreground = false;
  turns.cancelInterruptedSends();
  foreground = true;
  expect(canReceive?.()).toBe(false);
});
