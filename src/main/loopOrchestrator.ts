// §26.3/D47a + D48 — the work-agent turn runner: the in-app orchestrator state machine for ONE actor
// turn. It injects a composed prompt only while the hosted instance is injectable (§26.2), waits for a
// done-signal (a sentinel line OR file OR the manual override) AND the turn's artifact, retries once on
// failure, then stops the run in `error`. It owns no I/O — every effect is a domain port the host wires
// to the injector, the §8.3 quiescence signal, the artifact check, and the state.yaml writer.

export type TurnState = 'idle' | 'in-flight' | 'complete' | 'error';

export interface TurnRunnerDeps {
  /** The prompt for `turnKey` (recipe body + done-signal instruction); null = unrecoverable config error. */
  compose(turnKey: string): string | null;
  /** Inject + submit the prompt into the hosted instance (§9.3). */
  inject(prompt: string): void;
  /** True iff the instance is idle at its input box (§26.2): quiescent and the shell not busy. */
  injectable(): boolean;
  /** True iff the turn's expected artifact exists and parses (§26.3/D47a b); artifact-less turns pass a
   *  turn-appropriate check here. */
  artifactPresent(): boolean;
  /** Arm the completion timeout; the host calls `onTimeout()` when it elapses. */
  armTimer(): void;
  /** Cancel a previously-armed completion timeout. */
  cancelTimer(): void;
  /** Persist `status: error` with the reason (§26.3/D48). */
  writeError(reason: string): void;
  /** The turn produced its done-signal and artifact — advance (next slice continues the cycle). */
  onComplete(turnKey: string): void;
}

export interface TurnRunner {
  /** Begin a turn; injects now if injectable, else defers until `onInjectable()`. */
  requestTurn(turnKey: string): void;
  /** The instance just became injectable (a §8.3 quiet flip) — inject a pending/retry turn. */
  onInjectable(): void;
  /** A done-signal (sentinel line or file) was observed for the in-flight turn. */
  onDoneSignal(): void;
  /** The completion timer elapsed for the in-flight turn. */
  onTimeout(): void;
  /** Operator override (§26.3/D47a c): assert the in-flight turn is done. */
  markComplete(): void;
  state(): TurnState;
}

// Total injections per turn before the run errors: the initial attempt plus one retry (§26.3/D48).
const MAX_ATTEMPTS = 2;

export function createTurnRunner(deps: TurnRunnerDeps): TurnRunner {
  let state: TurnState = 'idle';
  let turnKey: string | null = null;
  let attempts = 0;
  let awaitingInjectable = false;

  const tryInject = (): void => {
    if (state !== 'in-flight' || turnKey === null) return;
    if (!deps.injectable()) {
      awaitingInjectable = true;
      return;
    }
    awaitingInjectable = false;
    const prompt = deps.compose(turnKey);
    if (prompt === null) {
      state = 'error';
      deps.writeError(`could not compose prompt for ${turnKey}`);
      return;
    }
    attempts += 1;
    deps.inject(prompt);
    deps.armTimer();
  };

  const fail = (reason: string): void => {
    if (state !== 'in-flight') return;
    deps.cancelTimer();
    if (attempts >= MAX_ATTEMPTS) {
      state = 'error';
      deps.writeError(reason);
      return;
    }
    tryInject(); // retry — defers itself if the instance is no longer injectable
  };

  const succeed = (): void => {
    deps.cancelTimer();
    const k = turnKey;
    state = 'complete';
    if (k !== null) deps.onComplete(k);
  };

  const resolveCompletion = (): void => {
    if (state !== 'in-flight') return;
    if (deps.artifactPresent()) succeed();
    else fail('done-signal received but the turn artifact is missing');
  };

  return {
    requestTurn(key) {
      if (state === 'in-flight') return; // a turn is already running; ignore re-entry
      state = 'in-flight';
      turnKey = key;
      attempts = 0;
      awaitingInjectable = false;
      tryInject();
    },
    onInjectable() {
      if (state === 'in-flight' && awaitingInjectable) tryInject();
    },
    onDoneSignal() {
      resolveCompletion();
    },
    onTimeout() {
      fail('completion timeout: no done-signal');
    },
    markComplete() {
      resolveCompletion();
    },
    state() {
      return state;
    },
  };
}
