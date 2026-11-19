import { expect, it } from 'vitest';
import { createSessionTurns, type SessionTurns } from '../../src/main/mcpSessionTurns';
import { hookInput } from '../helpers/fakeClaude';

type Delivery = Parameters<Parameters<SessionTurns['deliverPending']>[1]>[4];

function fixture() {
  const turns = createSessionTurns({ launchOf: async () => null });
  const session = { sessionId: 'caller', transcriptPath: '/transcript', cwd: '/repo' };
  const outcomes: (string | undefined)[] = [];
  const writes: string[] = [];
  const deliveries: Delivery[] = [];
  const start = () => turns.hook(9, hookInput.sessionStart(session, 'startup'));
  const prompt = (id: string) => turns.hook(9, hookInput.userPromptSubmit(session, id, 'send'));
  const stop = () => turns.hook(9, hookInput.stop(session));
  const send = (id: string) => turns.acceptSend(9, { id, text: id }, undefined, reason => outcomes.push(reason));
  const deliver = () => turns.deliverPending(true, (text, _pid, _recipient, _tmux, delivery) => {
    writes.push(text);
    deliveries.push(delivery);
  });
  return { turns, session, outcomes, writes, deliveries, start, prompt, stop, send, deliver };
}

it('only accepts sends in an open turn and delivers once after Stop, even when Stop is repeated', () => {
  const f = fixture();
  expect(f.send('absent')).toContain('no longer open');
  f.start();
  expect(f.send('idle')).toContain('no longer open');
  f.prompt('first');
  expect(f.send('accepted')).toBe(null);
  f.deliver();
  expect(f.writes).toEqual([]);
  f.stop();
  expect(f.turns.prompt(9)).toBe(null);
  expect(f.send('stopped')).toContain('no longer open');
  f.stop();
  f.deliver();
  f.stop();
  f.deliver();
  expect(f.writes).toEqual(['accepted']);
  expect(f.deliveries[0].canReceive()).toBe(true);
  f.deliveries[0].finish();
  f.deliveries[0].finish('late failure');
  expect(f.deliveries[0].canReceive()).toBe(false);
  expect(f.outcomes).toEqual([undefined]);
});

it('an unreadable hook loses the turn and cannot release its send on a later Stop', async () => {
  const f = fixture();
  f.start();
  f.prompt('first');
  expect(f.send('lost')).toBe(null);
  f.turns.hook(9, {});
  expect(f.turns.prompt(9)).toBe(null);
  expect(await f.turns.observe(9, observation => observation.origin)).toBe('undetermined');
  expect(f.send('unknown')).toContain('no longer open');
  f.stop();
  f.deliver();
  expect(f.writes).toEqual([]);
  f.prompt('recovered');
  expect(f.send('new')).toBe(null);
  f.stop();
  f.deliver();
  expect(f.writes).toEqual(['new']);
});

it.each(['new prompt', 'restart', 'end', 'injection', 'terminal close'] as const)(
  'a delivery interrupted by %s cannot receive or finish a later send', interruption => {
    const f = fixture();
    f.start();
    f.prompt('first');
    expect(f.send('old')).toBe(null);
    f.stop();
    f.deliver();
    const old = f.deliveries[0];
    expect(old.canReceive()).toBe(true);
    switch (interruption) {
      case 'new prompt': f.prompt('interrupt'); break;
      case 'restart': f.start(); break;
      case 'end': f.turns.hook(9, hookInput.sessionEnd(f.session, 'prompt_input_exit')); break;
      case 'injection': f.turns.injected('engine work', { submitted: true }); break;
      case 'terminal close': f.turns.cancelPending('terminal closed'); break;
      default: interruption satisfies never;
    }
    expect(old.canReceive()).toBe(false);
    expect(f.outcomes).toEqual([expect.any(String)]);
    f.prompt('second');
    expect(f.send('new')).toBe(null);
    f.stop();
    f.deliver();
    const current = f.deliveries[1];
    old.finish();
    expect(current.canReceive()).toBe(true);
    current.finish();
    f.deliver();
    expect(f.writes).toEqual(['old', 'new']);
    expect(f.outcomes).toEqual([expect.any(String), undefined]);
  },
);
