import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  classifyHostedAgent,
  createTurnRunner,
  decideConsolidateOutcome,
  hostedAgentPresent,
  type TurnRunnerDeps,
} from '../../src/main/loopOrchestrator';

// §26.2 — the mapping from presence + §8.3 activity to injection-readiness. `agentPresent` is the domain
// fact "a hosted agent occupies the prompt" (how the host derives it from OSC-133 spans is its concern);
// not present → `absent` (a bare shell, where an injected turn would leak), regardless of quiescence.
describe('classifyHostedAgent (§26.2 presence + idleness)', () => {
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

// §26.2 — deriving "a hosted agent occupies the prompt" from the OSC-133 command spans. A running span
// is the foreground agent; ZERO spans means the agent is itself the PTY program (no bash prompt to sit
// idle at — e.g. APP_SHELL=<agent>), also present. The absent case is the leak-prone one: instrumented
// spans exist but NONE is running — a bare ready prompt where an injected turn would type into the shell.
describe('hostedAgentPresent (§26.2 — present iff no bare idle prompt)', () => {
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

// §26.3/D47a + D48 — the work-agent turn runner. Asserted purely from the outside: which prompts get
// injected, whether the stall watchdog is armed/reset/cancelled, when onComplete fires, and when the run
// is written to `error`. No PTY, no real timers — the host drives onDoneSignal/onStall/onInjectable/noteActivity.
describe('loop turn runner (§26.3/D47a, D48)', () => {
  let hosted: 'idle' | 'busy' | 'absent';
  let artifact: boolean;
  let compose: Mock<(turnKey: string) => string | null>;
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
    inject = vi.fn();
    armTimer = vi.fn();
    cancelTimer = vi.fn();
    writeError = vi.fn();
    onComplete = vi.fn();
    noteSettle = vi.fn();
    compose = vi.fn((k: string) => `PROMPT for ${k}`);
    deps = {
      compose,
      inject,
      hostedAgent: () => hosted,
      artifactPresent: () => artifact,
      armTimer,
      cancelTimer,
      writeError,
      onComplete,
      noteSettle,
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

  it('a stall stops the run in error directly, without retrying the injection (§26.3)', () => {
    // The wall-clock completion deadline is gone: onStall means the screen went silent for the whole
    // (long) stall window while a turn was in flight — a genuine freeze, not a slow-but-working turn.
    // Re-injecting a frozen instance cannot help, so it errors straight to the human (recoverable Retry).
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

  it('never injects over a busy instance: defers until injectable (§26.2)', () => {
    hosted = 'busy';
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    expect(inject).not.toHaveBeenCalled();
    expect(r.state()).toBe('in-flight');
    hosted = 'idle';
    r.onInjectable();
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it('no hosted agent at the prompt: errors instead of leaking the prompt into the bare shell (§26.2)', () => {
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

  it('a deferred turn errors if the agent leaves the prompt while waiting (Claude quit mid-wait, §26.2)', () => {
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

  it('the manual mark-complete advances a sentinel-less turn whose artifact is present (§26.3/D47a c)', () => {
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
  it('the manual mark-complete never re-injects the turn when the artifact is absent (§26.3/D47a c)', () => {
    artifact = false;
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');
    inject.mockClear();

    r.markComplete();

    expect(inject).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('the manual mark-complete surfaces a recoverable error when the artifact is absent (§26.3/D48)', () => {
    artifact = false;
    const r = createTurnRunner(deps);
    r.requestTurn('work-plan');

    r.markComplete();

    expect(writeError).toHaveBeenCalledTimes(1);
    expect(r.state()).toBe('error');
    expect(cancelTimer).toHaveBeenCalled();
  });

  // A done-signal is the AGENT's claim; a missing artifact means it lied or crashed, so one retry is right.
  it('a done-signal with the artifact absent still retries the turn (unchanged, §26.3/D48)', () => {
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

  it('a turn deferred on a busy instance that never becomes injectable stalls into error (§26.3/D48)', () => {
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

  it('accepts a fresh turn after one completes (the §26.4 work→reviewers chain runs sequential turns)', () => {
    // L3 chains the reviewers turn off the work turn's completion: the host calls requestTurn again from
    // the `complete` state. The runner must start the new turn (a different key), not ignore it as re-entry.
    // §26.3/D46 — a CHAINED turn must not inject on the stale post-done-signal quiet level: it re-arms
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

  it('a follow-on turn re-arms quiescence and waits for a fresh settle before injecting (§26.3/D46 race fix)', () => {
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

  it('injects a turn preamble (/clear) first — gated — then the prompt only after a further settle (§26.3/D46)', () => {
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

// §26.13 L4/L6 / §26.6/§26.8 — after the consolidate turn completes, the normalized verdict decides the
// branch: `clean` STOPs at the phase post-clean gate; `needs-work` normally re-iterates, but routes to
// the phase's post-needs-work TRIAGE gate (a STOP for the human) at the iteration cap or flagged stuck
// (signature x2, §26.8). The cap counts the PER-LOOP internal window `iteration - capBaseline`, not the
// monotonic run-wide iteration: a chained-loop rebind and a request-changes both advance `capBaseline`,
// which resets the window (retiring phase-2's permanent gate-every-round routing).
describe('consolidate outcome decision (§26.6 / §26.8 / §26.13 L4/L6)', () => {
  const base = {
    postCleanGate: 'awaiting-human-plan-approval',
    postNeedsWorkGate: 'awaiting-human-plan-triage',
    capBaseline: 0,
    iterationCap: 0,
    stuck: false,
  };

  it('routes a clean verdict to the phase post-clean gate (STOP for the human)', () => {
    expect(decideConsolidateOutcome({ ...base, verdict: 'clean', iteration: 3 })).toEqual({
      kind: 'gate',
      status: 'awaiting-human-plan-approval',
    });
  });

  it('re-iterates a needs-work verdict when not at cap, not stuck', () => {
    expect(decideConsolidateOutcome({ ...base, verdict: 'needs-work', iteration: 3 })).toEqual({
      kind: 'reiterate',
      nextIteration: 4,
    });
  });

  it('routes a needs-work verdict to the triage gate at the iteration cap (§26.8)', () => {
    expect(decideConsolidateOutcome({ ...base, verdict: 'needs-work', iteration: 2, iterationCap: 2 })).toEqual({
      kind: 'gate',
      status: 'awaiting-human-plan-triage',
    });
  });

  it('re-iterates a needs-work verdict below the iteration cap', () => {
    expect(decideConsolidateOutcome({ ...base, verdict: 'needs-work', iteration: 1, iterationCap: 2 })).toEqual({
      kind: 'reiterate',
      nextIteration: 2,
    });
  });

  it('measures the cap from capBaseline, not the monotonic iteration (§26.6/§26.8)', () => {
    // internal = iteration - capBaseline = 7 - 2 = 5, which reaches the cap of 5.
    expect(
      decideConsolidateOutcome({ ...base, verdict: 'needs-work', iteration: 7, capBaseline: 2, iterationCap: 5 }),
    ).toEqual({ kind: 'gate', status: 'awaiting-human-plan-triage' });
  });

  it('re-iterates at the monotonic cap when the window was just reset (request-changes / rebind)', () => {
    // internal = iteration - capBaseline = 5 - 5 = 0: the reset gave a fresh window, so a verdict that
    // WOULD be at the monotonic cap (iteration >= cap) still auto-iterates (retires phase-2 routing).
    expect(
      decideConsolidateOutcome({ ...base, verdict: 'needs-work', iteration: 5, capBaseline: 5, iterationCap: 5 }),
    ).toEqual({ kind: 'reiterate', nextIteration: 6 });
  });

  it('clamps a hostile out-of-range capBaseline (> iteration) so the cap still fires (CWE-20/770)', () => {
    // cap_baseline is read from attacker-plantable .agent-loop/state.yaml and is always a PRIOR iteration
    // (<= the current one). A planted value larger than `iteration` would drive `iteration - capBaseline`
    // negative — the cap never reaches `>= iterationCap`, defeating the §26.8 runaway backstop. An
    // out-of-range baseline degrades to the monotonic window (`iteration - 0`), so the cap fires as it
    // would with no reset. Passing the reader's non-negative-integer gate is not enough on its own.
    expect(
      decideConsolidateOutcome({
        ...base,
        verdict: 'needs-work',
        iteration: 6,
        capBaseline: Number.MAX_SAFE_INTEGER,
        iterationCap: 5,
      }),
    ).toEqual({ kind: 'gate', status: 'awaiting-human-plan-triage' });
  });

  it('routes a needs-work verdict to the triage gate when flagged stuck (signature x2, §26.8)', () => {
    expect(decideConsolidateOutcome({ ...base, verdict: 'needs-work', iteration: 1, stuck: true })).toEqual({
      kind: 'gate',
      status: 'awaiting-human-plan-triage',
    });
  });

  it('falls back to re-iteration when a triage condition holds but the def names no triage gate', () => {
    expect(
      decideConsolidateOutcome({ ...base, verdict: 'needs-work', iteration: 2, iterationCap: 2, postNeedsWorkGate: '' }),
    ).toEqual({ kind: 'reiterate', nextIteration: 3 });
  });
});
