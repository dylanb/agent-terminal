import { expect, it, vi } from 'vitest';
import { createMcpTodoDelivery } from '../../src/main/mcpTodoDelivery';
import { createSessionTurns } from '../../src/main/mcpSessionTurns';
import { hookInput } from '../helpers/fakeClaude';

it.each([false, true])('owns persistence, deferred delivery and outcome recording (interrupted=%s)', interrupted => {
  vi.useFakeTimers();
  try {
    const received: string[] = [];
    const saved: string[] = [];
    const outcomes: (string | undefined)[] = [];
    let present = true;
    const turns = createSessionTurns({ launchOf: async () => null, recipientOf: () => present ? 'caller' : null });
    const delivery = createMcpTodoDelivery({ sessions: turns,
      destination: () => present ? { identity: 'caller', paste: text => received.push(text), write: text => received.push(text) } : null,
      markSent: (repo, id) => saved.push(`${repo}:${id}`),
      deliveryObserver: () => reason => outcomes.push(reason), noteInjection: () => {}, reportDrop: () => {},
    });
    const session = { sessionId: 'caller', transcriptPath: '/transcript', cwd: '/repo' };
    turns.hook(9, hookInput.sessionStart(session, 'startup'));
    turns.hook(9, hookInput.userPromptSubmit(session, 'prompt', 'send'));
    expect(delivery.send({ session: 9 }, '/repo', { id: 'one', text: 'retained' })).toBe(null);
    expect(saved).toEqual(['/repo:one']);
    expect(delivery.send({ session: 9 }, '/repo', { id: 'two', text: 'other' })).toContain('one');
    expect(saved).toEqual(['/repo:one']);
    delivery.flush(true);
    expect(received).toEqual([]);
    turns.hook(9, hookInput.stop(session));
    delivery.flush(true);
    expect(received).toEqual(['retained']);
    if (interrupted) { present = false; delivery.recipientChanged(); present = true; }
    vi.runAllTimers();
    expect(received).toEqual(interrupted ? ['retained'] : ['retained', '\r']);
    expect(outcomes).toEqual(interrupted ? [expect.any(String)] : [undefined]);
  } finally { vi.useRealTimers(); }
});
