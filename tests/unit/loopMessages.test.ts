import { expect, it } from 'vitest';
import { createLoopMessages } from '../../src/main/loopMessages';

it('holds only the latest loop message, each with its own identity, and starts with none', () => {
  const messages = createLoopMessages(() => {});
  expect(messages.current()).toBeNull();
  messages.post('error', 'the turn stalled');
  const first = messages.current();
  messages.post('notice', 'nothing to commit');
  expect(first).toEqual({ id: expect.any(String), kind: 'error', reason: 'the turn stalled' });
  expect(messages.current()).toEqual({ id: expect.any(String), kind: 'notice', reason: 'nothing to commit' });
  expect(messages.current()?.id).not.toBe(first?.id);
});

it('clears on dismissal of the message shown, and a dismissal of a replaced one keeps the newer message', () => {
  const messages = createLoopMessages(() => {});
  messages.post('error', 'first');
  const stale = messages.current()!.id;
  messages.post('error', 'second');
  messages.dismiss(stale);
  expect(messages.current()?.reason).toBe('second');
  messages.dismiss(messages.current()!.id);
  expect(messages.current()).toBeNull();
});

it('reports each change, and nothing for a dismissal that changed nothing', () => {
  let changes = 0;
  const messages = createLoopMessages(() => { changes++; });
  messages.post('error', 'first');
  messages.dismiss('not-shown');
  messages.dismiss(messages.current()!.id);
  expect(changes).toBe(2);
});

it('gives each reader its own copy', () => {
  const messages = createLoopMessages(() => {});
  messages.post('error', 'first');
  messages.current()!.reason = 'edited';
  expect(messages.current()?.reason).toBe('first');
});
