import { describe, it, expect } from 'vitest';
import { createFlowMachine } from '../../src/main/flow';

// §24.2.2 S1 — the walking-skeleton workflow state machine. A single hardcoded manual
// step with the lifecycle not_started --start--> in_progress --advance--> done; done is
// terminal. Tests assert only the observable contract: the state view and thrown errors
// on illegal transitions (the machine's internals are free to change).

describe('flow state machine (§24.2.2 S1)', () => {
  it('begins not_started at position 1/1 with a named step', () => {
    const flow = createFlowMachine();
    const s = flow.state();
    expect(s.status).toBe('not_started');
    expect(s.position).toBe(1);
    expect(s.total).toBe(1);
    expect(s.stepName.length).toBeGreaterThan(0);
  });

  it('start() advances not_started → in_progress and persists', () => {
    const flow = createFlowMachine();
    expect(flow.start().status).toBe('in_progress');
    expect(flow.state().status).toBe('in_progress');
  });

  it('advance() advances in_progress → done and persists', () => {
    const flow = createFlowMachine();
    flow.start();
    expect(flow.advance().status).toBe('done');
    expect(flow.state().status).toBe('done');
  });

  it('rejects every illegal transition and never mutates state when it does', () => {
    const flow = createFlowMachine();
    expect(() => flow.advance()).toThrow(); // not_started --advance--> illegal
    expect(flow.state().status).toBe('not_started');

    flow.start();
    expect(() => flow.start()).toThrow(); // in_progress --start--> illegal

    flow.advance();
    expect(() => flow.advance()).toThrow(); // done is terminal — a second Advance is impossible
    expect(() => flow.start()).toThrow();
    expect(flow.state().status).toBe('done');
  });
});
