import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  classifyHostedAgent,
  createTurnRunner,
  hostedAgentPresent,
  type TurnRunnerDeps,
} from '../../src/main/loopOrchestrator';

// §27.2 — the mapping from presence + §8.3 activity to injection-readiness. `agentPresent` is the domain
// fact "a hosted agent occupies the prompt" (how the host derives it from OSC-133 spans is its concern);
// not present → `absent` (a bare shell, where an injected turn would leak), regardless of quiescence.
describe('classifyHostedAgent (§27.2 presence + idleness)', () => {
  it('a bare ready prompt (no foreground command) is absent — no agent to inject into, regardless of quiescence', () => {
    expect(classifyHostedAgent(false, 'quiet')).toBe('absent');
    expect(classifyHostedAgent(false, 'active')).toBe('absent');
  });
  it('a present agent that is quiescent is idle at its input box', () => {
    expect(classifyHostedAgent(true, 'quiet')).toBe('idle');
  });
  it('a present agent still emitting output is busy (mid-turn) — defer, do not inject', () => {
    expect(classifyHostedAgent(true, 'active')).toBe('busy');
  });
});

// §27.2 — deriving "a hosted agent occupies the prompt" from the OSC-133 command spans. A running span
// is the foreground agent; ZERO spans means the agent is itself the PTY program (no bash prompt to sit
// idle at — e.g. APP_SHELL=<agent>), also present. The absent case is the leak-prone one: instrumented
// spans exist but NONE is running — a bare ready prompt where an injected turn would type into the shell.
describe('hostedAgentPresent (§27.2 — present iff no bare idle prompt)', () => {
  it('no span data at all is present (the agent is the PTY program, no bash prompt)', () => {
    expect(hostedAgentPresent([])).toBe(true);
  });
  it('a running span is present (the agent is the foreground command)', () => {
    expect(hostedAgentPresent([{ running: true }])).toBe(true);
    expect(hostedAgentPresent([{ running: false }, { running: true }])).toBe(true);
  });
  it('spans exist but none running is absent (a bare ready prompt — the leak case)', () => {
    expect(hostedAgentPresent([{ running: false }])).toBe(false);
    expect(hostedAgentPresent([{ running: false }, { running: false }])).toBe(false);
  });
});

// §27.12/D47a + D48 — the work-agent turn runner. Asserted purely from the outside: which prompts get
// injected, whether the stall watchdog is armed/reset/cancelled, when onComplete fires, and when the run
// is written to `error`. No PTY, no real timers — the host drives onDoneSignal/onStall/onInjectable/noteActivity.
describe('loop turn runner (§27.12/D47a, D48)', () => {
  let hosted: 'idle' | 'busy' | 'absent';
  let artifact: boolean;
  let shortfall: string;
  let compose: Mock<(turnKey: string, retry?: { reason: string }) => string | null>;
  let deps: TurnRunnerDeps;
  let inject: Mock<(prompt: string) => void>;
  let armTimer: Mock<() => void>;
  let cancelTimer: Mock<() => void>;
  let writeError: Mock<(reason: string) => void>;
  let onComplete: Mock<(turnKey: string) => void>;
  let noteSettle: Mock<() => void>;

  beforeEach(() => {
    hosted = 'idle';
    artifact = true;
    shortfall = 'the turn artifact is missing';
    inject = vi.fn();
    armTimer = vi.fn();
    cancelTimer = vi.fn();
    writeError = vi.fn();
    onComplete = vi.fn();
    noteSettle = vi.fn();
    compose = vi.fn((k: string, retry?: { reason: string }) => (retry ? `RETRY for ${k}: ${retry.reason}` : `PROMPT for ${k}`));
    deps = {
      compose,
      inject,
      hostedAgent: () => hosted,
      completionShortfall: () => (artifact ? null : shortfall),
      armTimer,
      cancelTimer,
      writeError,
      onComplete,
      noteSettle,
      resumeStalled: vi.fn(),
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

  it('forceChained defers an INITIAL turn to a fresh settle instead of injecting on the current quiet (§B.5 item 4b)', () => {
    // A default initial turn injects synchronously against the already-idle agent (test above). Forced
    // chained, it must re-arm quiescence and wait for a FRESH active→quiet edge, so a work turn requested
    // in the same tick as a just-submitted skill injection cannot race that injection (CWE-74).
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan', { forceChained: true });
    expect(inject).not.toHaveBeenCalled();
    expect(noteSettle).toHaveBeenCalledTimes(1);
    expect(r.state()).toBe('in-flight');
    r.onInjectable();
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith('PROMPT for work-plan');
  });

  it('a stall stops the run in error directly, without retrying the injection (§27.12)', () => {
    // onStall means the screen went silent for the whole stall window while a turn was in flight — a
    // frozen instance, or an agent waiting on the human. Re-injecting helps neither, so it goes straight
    // to the human.
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    expect(inject).toHaveBeenCalledTimes(1);
    r.onStall();
    expect(inject).toHaveBeenCalledTimes(1); // NOT re-injected
    expect(writeError).toHaveBeenCalledTimes(1);
    expect(writeError.mock.calls[0][0]).toContain('stall');
    expect(onComplete).not.toHaveBeenCalled();
    expect(r.state()).toBe('error');
  });

  it('a done-signal after a stall still completes the turn — an agent that waited on the human is not a failed turn (§27.12)', () => {
    const resumeStalled = vi.fn();
    const r = createTurnRunner({ ...deps, resumeStalled });
    r.requestTurn('work-plan');
    r.onStall();
    expect(r.state()).toBe('error');
    r.onDoneSignal();
    expect(resumeStalled).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('work-plan');
    expect(inject).toHaveBeenCalledTimes(1);
    expect(r.state()).toBe('complete');
  });

  it('a done-signal after a stall still faces the completion check, and a shortfall retries once as usual', () => {
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    r.onStall();
    artifact = false;
    r.onDoneSignal();
    expect(onComplete).not.toHaveBeenCalled();
    expect(inject).toHaveBeenLastCalledWith(`RETRY for work-plan: done-signal received but ${shortfall}`);
    expect(r.state()).toBe('in-flight');
  });

  it('a stalled turn the operator released (accepted or terminated) ignores a late done-signal', () => {
    const resumeStalled = vi.fn();
    const r = createTurnRunner({ ...deps, resumeStalled });
    r.requestTurn('work-plan');
    r.onStall();
    r.release();
    r.onDoneSignal();
    expect(resumeStalled).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    expect(r.state()).toBe('error');
  });

  it('a stall while still waiting to inject is not resumable by a done-signal — no prompt was ever sent', () => {
    hosted = 'busy';
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    r.onStall();
    r.onDoneSignal();
    expect(onComplete).not.toHaveBeenCalled();
    expect(r.state()).toBe('error');
  });

  it('an error that is not a stall still ignores a later done-signal', () => {
    const resumeStalled = vi.fn();
    artifact = false;
    const r = createTurnRunner({ ...deps, resumeStalled });
    r.requestTurn('work-plan');
    r.onDoneSignal();
    r.onDoneSignal();
    expect(r.state()).toBe('error');
    artifact = true;
    r.onDoneSignal();
    expect(resumeStalled).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('the stall reason tells the operator how to resume the turn', () => {
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    r.onStall();
    expect(writeError.mock.calls[0][0]).toContain('done file');
  });

  it('visible activity re-arms the stall deadline while in flight, but is inert once the turn ends', () => {
    // noteActivity is fired on every §8.3 content-change edge; while a turn is in flight it resets the
    // watchdog (a streaming turn never stalls). After the turn completes/errors it must NOT re-arm — a
    // late repaint on a finished turn cannot resurrect a dead deadline.
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    expect(armTimer).toHaveBeenCalledTimes(1); // armed on inject
    r.noteActivity();
    r.noteActivity();
    expect(armTimer).toHaveBeenCalledTimes(3); // each edge re-arms
    r.onDoneSignal();
    expect(r.state()).toBe('complete');
    armTimer.mockClear();
    r.noteActivity();
    expect(armTimer).not.toHaveBeenCalled();
  });

  it('treats a done-signal with the artifact missing as a failure (retries)', () => {
    artifact = false;
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    r.onDoneSignal(); // signalled, but plan.md absent
    expect(onComplete).not.toHaveBeenCalled();
    expect(inject).toHaveBeenCalledTimes(2); // retried
  });

  // §27.12 — the retry is told why the first attempt fell short, so the composer can ask for a targeted repair
  // instead of replaying the whole turn.
  it('composes the retry with the shortfall that caused it, and the first attempt with none', () => {
    const r = createTurnRunner(deps);
    r.requestTurn('review-plan');
    artifact = false;
    shortfall = 'the round report .agent-terminal/loop/reports/1.md is not well-formed';
    r.onDoneSignal();
    expect(inject.mock.calls.map((c) => c[0])).toEqual([
      'PROMPT for review-plan',
      'RETRY for review-plan: done-signal received but the round report .agent-terminal/loop/reports/1.md is not well-formed',
    ]);
  });

  it('a second missing-artifact done-signal stops the run in error (retry once, then error)', () => {
    artifact = false;
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    r.onDoneSignal(); // attempt 1: signalled, artifact absent -> retry
    r.onDoneSignal(); // attempt 2: still absent -> error
    expect(inject).toHaveBeenCalledTimes(2);
    expect(writeError).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
    expect(r.state()).toBe('error');
  });

  // §28 Option C — an optional pre-evaluated gate the caller (the engine, for a RED turn) ANDs into completion.
  // Absent (every non-RED turn) preserves the existing behavior; false fails with the caller's reason. Because
  // resolveCompletion runs while state is still 'in-flight', fail()->retry-then-error works with NO new state.
  describe('the threaded completion gate (Option C)', () => {
    // IT-RUNNER-1 — a gate arg is optional; no gate completes on the artifact alone (behavior preserved).
    it('completes on the artifact alone when no gate is passed', () => {
      artifact = true;
      const r = createTurnRunner(deps);
      r.requestTurn('work-plan');
      r.onDoneSignal(); // no gate
      expect(onComplete).toHaveBeenCalledWith('work-plan');
    });

    // IT-RUNNER-2 — a false gate fails even when the artifact is present (both required), and retries.
    it('fails on a false gate even when the artifact is present, and retries', () => {
      artifact = true;
      const r = createTurnRunner(deps);
      r.requestTurn('work-plan');
      r.onDoneSignal({ ok: false, reason: 'RED requires a failing test — no test file was added' });
      expect(onComplete).not.toHaveBeenCalled();
      expect(inject).toHaveBeenCalledTimes(2); // retried, exactly like a missing artifact
    });

    // IT-RUNNER-3 — a passing gate still requires the artifact (both conditions).
    it('a passing gate still requires the artifact', () => {
      artifact = false;
      const r = createTurnRunner(deps);
      r.requestTurn('work-plan');
      r.onDoneSignal({ ok: true });
      expect(onComplete).not.toHaveBeenCalled();
      expect(inject).toHaveBeenCalledTimes(2); // artifact absent -> retry
    });

    // IT-RUNNER-4 — a false-gate done-signal drives retry-then-error carrying the caller's OWN reason.
    it('a false-gate done-signal drives retry-then-error carrying the caller reason', () => {
      artifact = true;
      const r = createTurnRunner(deps);
      r.requestTurn('work-plan');
      const reason = 'RED requires a failing test — no test file was added';
      r.onDoneSignal({ ok: false, reason }); // attempt 1 -> retry
      r.onDoneSignal({ ok: false, reason }); // attempt 2 -> error
      expect(inject).toHaveBeenCalledTimes(2);
      expect(writeError).toHaveBeenCalledTimes(1);
      expect(writeError.mock.calls[0][0]).toBe(reason); // the caller's reason, not the completion shortfall's
      expect(r.state()).toBe('error');
    });

    // IT-RUNNER-5 — a PASSING gate with the artifact absent errors with the completion shortfall's text, not a
    // gate reason: the two failure causes never mislabel each other.
    it('a passing gate with a missing artifact errors with the completion shortfall text', () => {
      artifact = false;
      const r = createTurnRunner(deps);
      r.requestTurn('work-plan');
      r.onDoneSignal({ ok: true }); // attempt 1 -> retry
      r.onDoneSignal({ ok: true }); // attempt 2 -> error
      expect(writeError).toHaveBeenCalledTimes(1);
      expect(writeError.mock.calls[0][0]).toBe(`done-signal received but ${shortfall}`);
    });
  });

  it('never injects over a busy instance: defers until injectable (§27.2)', () => {
    hosted = 'busy';
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    expect(inject).not.toHaveBeenCalled();
    expect(r.state()).toBe('in-flight');
    hosted = 'idle';
    r.onInjectable();
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it('no hosted agent at the prompt: errors instead of leaking the prompt into the bare shell (§27.2)', () => {
    // The motivating defect: injecting on raw quiescence typed a whole work-agent prompt into bash when
    // no Claude instance was at the prompt. `absent` (normal buffer / no agent) must NEVER inject — it
    // stops in `error` (D48, human-needed) so the operator is told to start Claude, not left with a
    // prompt silently pasted into the shell. Distinct from `busy`, which defers and waits.
    hosted = 'absent';
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    expect(inject).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledTimes(1);
    expect(r.state()).toBe('error');
  });

  it('a deferred turn errors if the agent leaves the prompt while waiting (Claude quit mid-wait, §27.2)', () => {
    // Busy → deferred (wait it out). If the agent then disappears (operator quits Claude → normal buffer),
    // the next injectable poke must resolve to `error`, not re-inject into the now-bare shell.
    hosted = 'busy';
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    expect(inject).not.toHaveBeenCalled();
    hosted = 'absent';
    r.onInjectable();
    expect(inject).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledTimes(1);
    expect(r.state()).toBe('error');
  });

  it('a missing-artifact retry also waits for the instance to become injectable before re-injecting', () => {
    artifact = false;
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan'); // injected (attempt 1)
    hosted = 'busy';
    r.onDoneSignal(); // signalled but artifact absent -> wants to retry, but instance is busy
    expect(inject).toHaveBeenCalledTimes(1);
    hosted = 'idle';
    r.onInjectable();
    expect(inject).toHaveBeenCalledTimes(2);
  });

  it('the manual mark-complete advances a sentinel-less turn whose artifact is present (§27.12/D47a c)', () => {
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    inject.mockClear();
    r.markComplete();
    expect(onComplete).toHaveBeenCalledWith('work-plan');
    expect(inject).not.toHaveBeenCalled();
    expect(r.state()).toBe('complete');
  });

  // The operator's override is "this turn is done", never "run it again". Routing it through the
  // done-signal's missing-artifact retry re-injects the whole prompt into the agent the operator was
  // trying to move past — and does so silently, leaving no error to see and nothing to retry.
  it('the manual mark-complete never re-injects the turn when the artifact is absent (§27.12/D47a c)', () => {
    artifact = false;
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    inject.mockClear();

    r.markComplete();

    expect(inject).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('the manual mark-complete surfaces a recoverable error when the artifact is absent (§27.12/D48)', () => {
    artifact = false;
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');

    r.markComplete();

    expect(writeError).toHaveBeenCalledTimes(1);
    expect(r.state()).toBe('error');
    expect(cancelTimer).toHaveBeenCalled();
  });

  it('the error names what fell short, on both the done-signal and the manual mark-complete', () => {
    artifact = false;
    shortfall = 'the round report .agent-terminal/loop/reports/3.md is not well-formed';
    const signalled = createTurnRunner(deps);
    signalled.requestTurn('review-refactor');
    signalled.onDoneSignal();
    signalled.onDoneSignal();
    const marked = createTurnRunner(deps);
    marked.requestTurn('review-refactor');
    marked.markComplete();

    expect(writeError.mock.calls.map(([reason]) => reason)).toEqual([
      `done-signal received but ${shortfall}`,
      `marked complete but ${shortfall}`,
    ]);
  });

  // A done-signal is the AGENT's claim; a missing artifact means it lied or crashed, so one retry is right.
  it('a done-signal with the artifact absent still retries the turn (unchanged, §27.12/D48)', () => {
    artifact = false;
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    inject.mockClear();

    r.onDoneSignal();

    expect(inject).toHaveBeenCalledTimes(1);
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

  it('a turn deferred on a busy instance that never becomes injectable stalls into error (§27.12/D48)', () => {
    // The failure-safety gap D48 closes: a turn requested while the instance is busy defers. The stall
    // watchdog runs during the wait (armed on defer, reset by any visible activity), so an instance that
    // stays busy but goes silent — never returning to injectable — still resolves to `error` (human-needed)
    // rather than hanging forever in-flight with no attention cue.
    hosted = 'busy'; // the instance is — and stays — busy
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    expect(inject).not.toHaveBeenCalled(); // deferred, nothing injected into a busy instance
    expect(armTimer).toHaveBeenCalledTimes(1); // watchdog armed while we wait
    expect(r.state()).toBe('in-flight');
    r.onStall(); // the wait went silent for the whole stall window, instance still busy
    expect(inject).not.toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledTimes(1);
    expect(writeError.mock.calls[0][0]).toContain('injectable');
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

  it('accepts a fresh turn after one completes (the §27.3 work→reviewers chain runs sequential turns)', () => {
    // L3 chains the reviewers turn off the work turn's completion: the host calls requestTurn again from
    // the `complete` state. The runner must start the new turn (a different key), not ignore it as re-entry.
    // §27.12/D46 — a CHAINED turn must not inject on the stale post-done-signal quiet level: it re-arms
    // quiescence (noteSettle) and injects only once a fresh settle arrives (onInjectable).
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    r.onDoneSignal();
    expect(r.state()).toBe('complete');

    r.requestTurn('review-plan');
    expect(r.state()).toBe('in-flight');
    expect(inject).toHaveBeenCalledTimes(1); // NOT injected yet — waiting for the fresh settle
    r.onInjectable();
    expect(inject).toHaveBeenLastCalledWith('PROMPT for review-plan');
    r.onDoneSignal();
    expect(onComplete).toHaveBeenLastCalledWith('review-plan');
    expect(r.state()).toBe('complete');
  });

  it('a follow-on turn re-arms quiescence and waits for a fresh settle before injecting (§27.12/D46 race fix)', () => {
    // The reported data-loss bug: the follow-on prompt was injected the instant the previous turn's
    // done-signal FILE appeared — a written file is not §8.3 quiescence, so the agent was often still
    // streaming and the prompt was swallowed. A chained turn must instead re-arm the quiescence window
    // (noteSettle) and defer until a fresh active→quiet edge (onInjectable), regardless of the stale level.
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan'); // initial turn: injects immediately against the idle agent
    expect(inject).toHaveBeenCalledTimes(1);
    r.onDoneSignal();
    expect(r.state()).toBe('complete');

    inject.mockClear();
    hosted = 'idle'; // the level currently READS quiet — but it is the stale pre-done-signal quiet
    r.requestTurn('review-plan');
    expect(noteSettle).toHaveBeenCalledTimes(1); // re-armed the quiescence window
    expect(inject).not.toHaveBeenCalled(); // did NOT inject on the stale quiet level
    expect(r.state()).toBe('in-flight');

    r.onInjectable(); // the fresh, post-done-signal settle finally arrives
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith('PROMPT for review-plan');
  });

  it('the INITIAL turn injects immediately on the idle agent (no settle wait — the agent was already at rest)', () => {
    // The re-arm only guards CHAINED turns. The first turn after pickup has no prior turn output to race,
    // so it must inject on the current idle level without waiting for a (never-coming) fresh edge.
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    expect(noteSettle).not.toHaveBeenCalled();
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it('injects a turn preamble (/clear) first — gated — then the prompt only after a further settle (§27.12/D46)', () => {
    // The actor-boundary /clear must itself be quiescence-gated and ORDERED before the turn prompt: an
    // un-gated /clear (fired on the done-signal file) races the agent and swallows the follow-on prompt,
    // losing context. The boundary is a serialized pair of gated injections [/clear, prompt]: /clear on
    // the first fresh settle, the prompt only after /clear has drained and the agent re-quiesced.
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan'); // initial
    r.onDoneSignal(); // complete
    inject.mockClear();
    noteSettle.mockClear();

    r.requestTurn('consolidate-plan', { preamble: '/clear' }); // chained + preamble
    expect(noteSettle).toHaveBeenCalledTimes(1); // chained: re-arm before /clear
    expect(inject).not.toHaveBeenCalled(); // waits for the fresh settle

    r.onInjectable(); // first settle arrives
    expect(inject).toHaveBeenCalledTimes(1);
    // ONLY /clear — not the prompt yet — and flagged as the preamble so the host keeps the "waiting" readout.
    expect(inject).toHaveBeenCalledWith('/clear', { preamble: true });
    expect(noteSettle).toHaveBeenCalledTimes(2); // re-armed again so the prompt waits for /clear to drain

    r.onInjectable(); // second settle, after /clear drained
    expect(inject).toHaveBeenCalledTimes(2);
    expect(inject).toHaveBeenLastCalledWith('PROMPT for consolidate-plan'); // the prompt, no preamble flag
    expect(r.state()).toBe('in-flight');
  });
});
