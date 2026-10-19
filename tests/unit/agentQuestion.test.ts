import { describe, expect, it } from 'vitest';
import { createAgentQuestion } from '../../src/main/agentQuestion';
import type { HostedAgentState } from '../../src/main/loopOrchestrator';

// §27.9.1 N9b.10, §27.2

function rig(initial: HostedAgentState) {
  let state = initial;
  const injected: string[] = [];
  const q = createAgentQuestion({ readiness: () => state, inject: (text) => void injected.push(text) });
  return { q, injected, set: (s: HostedAgentState) => (state = s) };
}

describe('createAgentQuestion', () => {
  it('injects at once when the agent is idle', () => {
    const r = rig('idle');
    r.q.ask('why?');
    expect(r.injected).toEqual(['why?']);
  });

  it('holds the question while the agent is busy and injects it once on the next injectable edge', () => {
    const r = rig('busy');
    r.q.ask('why?');
    expect(r.injected).toEqual([]);
    r.set('idle');
    r.q.onInjectable();
    r.q.onInjectable();
    expect(r.injected).toEqual(['why?']);
  });

  it('a later question replaces a held one', () => {
    const r = rig('busy');
    r.q.ask('first');
    r.q.ask('second');
    r.set('idle');
    r.q.onInjectable();
    expect(r.injected).toEqual(['second']);
  });

  it('a withdrawn question is never injected', () => {
    const r = rig('busy');
    r.q.ask('why?');
    r.q.withdraw();
    r.set('idle');
    r.q.onInjectable();
    expect(r.injected).toEqual([]);
  });

  it('drops the question when no agent is hosted', () => {
    const r = rig('absent');
    r.q.ask('why?');
    r.set('idle');
    r.q.onInjectable();
    expect(r.injected).toEqual([]);
  });

  it('an injection that throws does not escape', () => {
    const q = createAgentQuestion({ readiness: () => 'idle', inject: () => { throw new Error('pty gone'); } });
    expect(() => q.ask('why?')).not.toThrow();
  });
});
