import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createTurnRunner, type TurnRunnerDeps } from '../../src/main/loopOrchestrator';

// §26.3/D47a + D48 — the work-agent turn runner. Asserted purely from the outside: which prompts get
// injected, whether the completion timer is armed/cancelled, when onComplete fires, and when the run is
// written to `error`. No PTY, no real timers — the host drives onDoneSignal/onTimeout/onInjectable.
describe('loop turn runner (§26.3/D47a, D48)', () => {
  let injectable: boolean;
  let artifact: boolean;
  let compose: Mock<(turnKey: string) => string | null>;
  let deps: TurnRunnerDeps;
  let inject: Mock<(prompt: string) => void>;
  let armTimer: Mock<() => void>;
  let cancelTimer: Mock<() => void>;
  let writeError: Mock<(reason: string) => void>;
  let onComplete: Mock<(turnKey: string) => void>;

  beforeEach(() => {
    injectable = true;
    artifact = true;
    inject = vi.fn();
    armTimer = vi.fn();
    cancelTimer = vi.fn();
    writeError = vi.fn();
    onComplete = vi.fn();
    compose = vi.fn((k: string) => `PROMPT for ${k}`);
    deps = {
      compose,
      inject,
      injectable: () => injectable,
      artifactPresent: () => artifact,
      armTimer,
      cancelTimer,
      writeError,
      onComplete,
    };
  });

  it('injects the composed prompt and arms the timer, then completes on done-signal + artifact', () => {
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith('PROMPT for work-plan');
    expect(armTimer).toHaveBeenCalledTimes(1);
    expect(r.state()).toBe('in-flight');

    r.onDoneSignal();
    expect(onComplete).toHaveBeenCalledWith('work-plan');
    expect(cancelTimer).toHaveBeenCalled();
    expect(writeError).not.toHaveBeenCalled();
    expect(r.state()).toBe('complete');
  });

  it('a completion timeout retries the turn exactly once, then completes', () => {
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    r.onTimeout(); // first attempt produced nothing
    expect(inject).toHaveBeenCalledTimes(2); // re-injected once
    expect(writeError).not.toHaveBeenCalled();
    r.onDoneSignal();
    expect(onComplete).toHaveBeenCalledWith('work-plan');
    expect(r.state()).toBe('complete');
  });

  it('a second failure stops the run in error (retry once, then error)', () => {
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    r.onTimeout(); // attempt 1 fails -> retry
    r.onTimeout(); // attempt 2 fails -> error
    expect(inject).toHaveBeenCalledTimes(2);
    expect(writeError).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    expect(r.state()).toBe('error');
  });

  it('treats a done-signal with the artifact missing as a failure (retries)', () => {
    artifact = false;
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    r.onDoneSignal(); // signalled, but plan.md absent
    expect(onComplete).not.toHaveBeenCalled();
    expect(inject).toHaveBeenCalledTimes(2); // retried
  });

  it('never injects over a busy instance: defers until injectable (§26.2)', () => {
    injectable = false;
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    expect(inject).not.toHaveBeenCalled();
    expect(r.state()).toBe('in-flight');
    injectable = true;
    r.onInjectable();
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it('a retry also waits for the instance to become injectable before re-injecting', () => {
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan'); // injected (attempt 1)
    injectable = false;
    r.onTimeout(); // wants to retry, but instance is busy
    expect(inject).toHaveBeenCalledTimes(1);
    injectable = true;
    r.onInjectable();
    expect(inject).toHaveBeenCalledTimes(2);
  });

  it('the manual mark-complete advances a sentinel-less turn whose artifact is present (§26.3/D47a c)', () => {
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    inject.mockClear();
    r.markComplete();
    expect(onComplete).toHaveBeenCalledWith('work-plan');
    expect(inject).not.toHaveBeenCalled();
    expect(r.state()).toBe('complete');
  });

  it('a compose failure stops in error without injecting (config error, no retry)', () => {
    compose.mockReturnValue(null);
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    expect(inject).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledTimes(1);
    expect(r.state()).toBe('error');
  });

  it('ignores a stray done-signal when no turn is in flight', () => {
    const r = createTurnRunner(deps);
    expect(() => r.onDoneSignal()).not.toThrow();
    expect(onComplete).not.toHaveBeenCalled();
    expect(r.state()).toBe('idle');
  });

  it('a retry that can never inject (instance never becomes injectable) still stops in error (§26.3/D48)', () => {
    // The failure-safety gap D48 closes: after a timeout the retry defers when the instance is busy. If
    // the instance never returns to injectable, the run must still resolve to `error` (human-needed),
    // not hang forever in-flight with no attention cue.
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan'); // attempt 1 injected
    expect(inject).toHaveBeenCalledTimes(1);
    injectable = false; // the instance goes — and stays — busy
    r.onTimeout(); // attempt 1 times out → wants to retry, but cannot inject → deferred
    expect(inject).toHaveBeenCalledTimes(1); // no second injection
    expect(r.state()).toBe('in-flight');
    r.onTimeout(); // the deferred wait-for-injectable deadline elapses, instance still busy
    expect(writeError).toHaveBeenCalledTimes(1);
    expect(r.state()).toBe('error');
  });

  it('ignores a second requestTurn while a turn is in flight (no re-inject, no attempt reset)', () => {
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    expect(inject).toHaveBeenCalledTimes(1);
    r.requestTurn('work-plan'); // re-entry while in-flight must be a no-op
    expect(inject).toHaveBeenCalledTimes(1);
    // the original turn still completes normally (attempts were not reset under it)
    r.onDoneSignal();
    expect(onComplete).toHaveBeenCalledWith('work-plan');
    expect(r.state()).toBe('complete');
  });

  it('accepts a fresh turn after one completes (the §26.4 work→reviewers chain runs sequential turns)', () => {
    // L3 chains the reviewers turn off the work turn's completion: the host calls requestTurn again from
    // the `complete` state. The runner must start the new turn (a different key), not ignore it as re-entry.
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    r.onDoneSignal();
    expect(r.state()).toBe('complete');

    r.requestTurn('review-plan');
    expect(r.state()).toBe('in-flight');
    expect(inject).toHaveBeenLastCalledWith('PROMPT for review-plan');
    r.onDoneSignal();
    expect(onComplete).toHaveBeenLastCalledWith('review-plan');
    expect(r.state()).toBe('complete');
  });
});
