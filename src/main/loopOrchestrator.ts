// §27.12 — the in-app turn-runner state machine for ONE actor turn. It owns no I/O: every effect is a
// domain port the host wires to the §9.3 injector, the §8.3 quiescence signal, the artifact check, and the
// run-state writer (the CLAUDE.md domain-port seam — the runner names what it needs, not the backing
// mechanism). The §27 app-loop engine is its consumer.

import type { AgentState } from '../shared/ipc';

export type TurnState = 'idle' | 'in-flight' | 'complete' | 'error';

/** The hosted instance's state relative to injection (§27.2), in the runner's own vocabulary — a domain
 *  concept, NOT a shell-busy check (the agent is itself the foreground process):
 *    'idle'   — a hosted agent is at its own input box and quiescent (§8.3): inject now.
 *    'busy'   — a hosted agent is present but mid-turn: defer until `onInjectable()`.
 *    'absent' — no hosted agent at the prompt (a bare shell): NEVER inject. Injecting would type the whole
 *               prompt into the shell (the motivating leak); the run stops in `error` instead. */
export type HostedAgentState = 'idle' | 'busy' | 'absent';

/** Derive the §27.2 presence fact from the OSC-133 command spans: a hosted agent occupies the prompt
 *  unless the shell is sitting idle at a bare ready prompt. That idle case — instrumented spans exist but
 *  NONE is running — is exactly where an injected turn would leak into the shell (the motivating defect),
 *  so it is the only `false`. A running span (the agent is the foreground command) OR zero spans (the
 *  agent is itself the PTY program, so there is no bash prompt to sit idle at — e.g. APP_SHELL=<agent>)
 *  are both present. Coupling: this leans on the shim instrumenting every interactive shell (§15.5); a
 *  future uninstrumented shell would produce zero spans and read as present. Pure so the gate is tested. */
export function hostedAgentPresent(spans: readonly { running: boolean }[]): boolean {
  return spans.length === 0 || spans.some((s) => s.running);
}

/** Map presence + activity to injection-readiness (§27.2). `agentPresent` is the host-supplied domain
 *  fact "a hosted agent occupies the prompt" (vs a bare shell where an injected turn would leak); how the
 *  host derives it (§27.2 command-span state) is not this function's concern. Absent → `absent` (never
 *  inject). Present → §8.3 quiescence separates idle-at-input-box from mid-turn. Pure so the gate is tested. */
export function classifyHostedAgent(agentPresent: boolean, agentState: AgentState): HostedAgentState {
  if (!agentPresent) return 'absent';
  return agentState === 'quiet' ? 'idle' : 'busy';
}

/** Why a turn is being re-injected (§27.12): the completion shortfall of the attempt before it. */
export interface RetryCause {
  reason: string;
}

export interface TurnRunnerDeps {
  /** The prompt for `turnKey` (recipe body + done-signal instruction); null = unrecoverable config error.
   *  `retry` is present on the re-injection after a failed completion and carries the reason it failed. */
  compose(turnKey: string, retry?: RetryCause): string | null;
  /** Inject + submit `prompt` into the hosted instance (§9.3). `opts.preamble` marks the actor-boundary
   *  /clear drained ahead of the turn, so the host can tell it apart from the turn prompt (§27 activity). */
  inject(prompt: string, opts?: { preamble?: boolean }): void;
  /** The hosted instance's injection-readiness (§27.2) — see `HostedAgentState`. `absent` is the guard that
   *  keeps a prompt from ever leaking into a bare shell: it errors rather than injecting or deferring. */
  hostedAgent(): HostedAgentState;
  /** Null when the turn's completion condition holds (§27.12); otherwise the operator-facing clause it falls
   *  short on, phrased to follow "done-signal received but …". */
  completionShortfall(): string | null;
  /** Why this turn's output can never complete however often it is retried, or null — an error at once. */
  unretryableShortfall?(): string | null;
  /** Arm (or re-arm) the stall watchdog; the host calls `onStall()` when it elapses with no intervening
   *  `noteActivity()`. Not a completion deadline — a working turn keeps it reset via visible activity. */
  armTimer(): void;
  /** Cancel a previously-armed stall watchdog. */
  cancelTimer(): void;
  /** Persist `status: error` with the reason (§27.12); `stalled` when the turn stopped on a stall after its
   *  prompt went in, so its own done-signal still completes it. */
  writeError(reason: string, stalled?: boolean): void;
  /** §27.10 */
  injectionRefusal(): string | null;
  /** §27.12 — a stalled turn's done-signal arrived: the turn is back in flight, so the stall error no longer
   *  holds. Called before the completion check, which then completes, retries, or errors the turn as usual. */
  resumeStalled(): void;
  /** The turn produced its done-signal and artifact — advance (next slice continues the cycle). */
  onComplete(turnKey: string): void;
  /** §27.12 — re-arm the §8.3 quiescence window: require a FRESH settle (a new active→quiet edge)
   *  before the next injection, so a chained turn never injects on the stale quiet the previous turn's
   *  done-signal FILE left behind. The host satisfies this by re-arming the shadow quiescence detector. */
  noteSettle(): void;
}

/** A completion condition a caller evaluated ahead of the done-signal (the engine's async machine ground truth
 *  for a RED/GREEN turn, §28 Option C). A discriminated union so a failing gate MUST carry the `reason` that
 *  becomes the error-surface text and a passing gate carries none — a reasonless failure (which would be
 *  misreported as a completion shortfall) is unconstructable. */
export type PrecomputedGate = { ok: true } | { ok: false; reason: string };

export interface TurnRunner {
  /** Begin a turn; injects now if the hosted agent is idle, defers if busy, errors if absent (§27.2).
   *  `opts.preamble` (§27.12) is a command drained BEFORE the turn prompt — the actor-boundary /clear —
   *  injected gated on its own settle and ordered ahead of the prompt, so neither races the agent.
   *  `opts.forceChained` (§B.5 item 4b) forces the chained arm on an INITIAL turn: the runner re-arms
   *  quiescence and waits for a fresh settle instead of injecting on the current quiet, so a work turn
   *  requested in the same tick as a just-submitted skill injection never races it (CWE-74). */
  requestTurn(turnKey: string, opts?: { preamble?: string; forceChained?: boolean }): void;
  /** The instance may have become injectable (a §8.3 quiet flip) — re-evaluate a pending/retry turn: inject
   *  if now idle, keep waiting if still busy, or error if the agent has left the prompt (§27.2). */
  onInjectable(): void;
  /** A done-signal was observed for the in-flight turn (§27.12). `gate` is the caller's OPTIONAL pre-evaluated
   *  completion condition (§28 Option C — see PrecomputedGate); omitting it preserves the prior behavior. */
  onDoneSignal(gate?: PrecomputedGate): void;
  /** A visible-content-change edge (§8.3) was observed — reset the in-flight turn's stall watchdog. */
  noteActivity(): void;
  /** The stall watchdog elapsed for the in-flight turn (no visible activity for the whole window). */
  onStall(): void;
  /** Operator override (§27.12): assert the in-flight turn is done. */
  markComplete(): void;
  /** The operator took a stalled turn out of the runner's hands (accept or terminate): a later done-signal for
   *  it must not complete it a second time. */
  release(): void;
  state(): TurnState;
  /** A turn that went quiet after its prompt went in, which its own done-signal still finishes (§27.12). */
  stalled(): boolean;
  /** How many state changes the runner has made; one value never repeats, so a round trip back to the same
   *  state still reads as a change. */
  transitions(): number;
}

// Total injections per turn before the run errors: the initial attempt plus one retry on a missing
// artifact (§27.12). A stall never retries — it goes straight to the human.
const MAX_ATTEMPTS = 2;

export function createTurnRunner(deps: TurnRunnerDeps): TurnRunner {
  let state: TurnState = 'idle';
  let transitions = 0;
  const setState = (next: TurnState): void => {
    state = next;
    transitions += 1;
  };
  let turnKey: string | null = null;
  let attempts = 0;
  let awaitingInjectable = false;
  // §27.12 — the turn stopped on a stall after its prompt went in, so its own done-signal still completes it.
  let stalled = false;
  // §27.12 — a command (the actor-boundary /clear) to drain, gated, BEFORE the turn prompt. Consumed on
  // its own settle; injecting it re-arms quiescence so the prompt waits for /clear to drain (serialized pair).
  let preamble: string | null = null;
  let retryCause: RetryCause | null = null;

  const tryInject = (): void => {
    if (state !== 'in-flight' || turnKey === null) return;
    const refusal = deps.injectionRefusal();
    if (refusal !== null) {
      awaitingInjectable = false;
      deps.cancelTimer();
      setState('error');
      deps.writeError(refusal);
      return;
    }
    const agent = deps.hostedAgent();
    if (agent === 'absent') {
      // §27.2 — no hosted agent at the prompt (a bare shell). Injecting now would type the whole prompt
      // into the shell (the motivating defect). Never inject, never defer waiting for an agent that isn't
      // there: stop in `error` (human-needed) so the operator is told to start Claude and retry.
      awaitingInjectable = false;
      deps.cancelTimer();
      setState('error');
      deps.writeError('no hosted agent at the prompt');
      return;
    }
    if (agent === 'busy') {
      awaitingInjectable = true;
      // The stall watchdog runs during the wait — visible activity (the busy instance is producing output)
      // keeps resetting it, so only a genuinely frozen instance that never returns to injectable resolves
      // to `error` (§27.12) instead of hanging. Safe to arm on the first wait now that it is
      // activity-gated (a long window reset by any repaint), not a wall-clock deadline racing quiescence.
      deps.armTimer();
      return;
    }
    awaitingInjectable = false;
    // §27.12 — the agent is idle: drain the /clear preamble FIRST, gated. Inject it, re-arm quiescence
    // (so the prompt waits for /clear to drain and the agent to re-quiesce), and defer until that settle.
    if (preamble !== null) {
      const cmd = preamble;
      preamble = null;
      deps.inject(cmd, { preamble: true });
      deps.noteSettle();
      awaitingInjectable = true;
      deps.armTimer();
      return;
    }
    const prompt = retryCause !== null ? deps.compose(turnKey, retryCause) : deps.compose(turnKey);
    if (prompt === null) {
      deps.cancelTimer();
      setState('error');
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
      setState('error');
      deps.writeError(reason);
      return;
    }
    retryCause = { reason };
    tryInject();
  };

  const succeed = (): void => {
    deps.cancelTimer();
    const k = turnKey;
    setState('complete');
    if (k !== null) deps.onComplete(k);
  };

  const resolveCompletion = (gate?: PrecomputedGate): void => {
    if (state === 'error' && stalled) {
      stalled = false;
      setState('in-flight');
      deps.resumeStalled();
    }
    if (state !== 'in-flight') return;
    const g = gate ?? { ok: true };
    // Runs while state is still 'in-flight', so a not-satisfied result routes through the existing fail() ->
    // retry-then-error with NO new runner state — the whole reason the gate is a threaded value, not an await in
    // the runner (§28 Option C). A false gate carries ITS OWN reason; under a passing gate the completion
    // shortfall's own text is reported — so the two failure causes never mislabel each other.
    const shortfall = deps.completionShortfall();
    const unretryable = deps.unretryableShortfall?.() ?? null;
    if (unretryable !== null) {
      deps.cancelTimer();
      setState('error');
      deps.writeError(unretryable);
      return;
    }
    if (shortfall === null && g.ok) succeed();
    else fail(g.ok ? `done-signal received but ${shortfall}` : g.reason);
  };

  return {
    requestTurn(key, opts) {
      if (state === 'in-flight') return;
      // §27.12 — a CHAINED turn (requested after a prior turn completed or errored) must not inject on
      // the stale quiet the previous turn's done-signal left behind: re-arm quiescence and defer until a
      // FRESH settle (onInjectable). The INITIAL turn (state 'idle') has no prior output to race, so it
      // injects immediately against the already-at-rest agent — UNLESS the caller forces the chained arm
      // because it just submitted an injection this turn must not race (§B.5 item 4b).
      const chained = state === 'complete' || state === 'error' || opts?.forceChained === true;
      setState('in-flight');
      turnKey = key;
      attempts = 0;
      retryCause = null;
      awaitingInjectable = false;
      stalled = false;
      preamble = opts?.preamble ?? null;
      if (chained) {
        deps.noteSettle();
        awaitingInjectable = true;
        deps.armTimer();
        return;
      }
      tryInject();
    },
    onInjectable() {
      if (state === 'in-flight' && awaitingInjectable) tryInject();
    },
    onDoneSignal(gate) {
      resolveCompletion(gate);
    },
    noteActivity() {
      // Every §8.3 visible-content edge resets the stall watchdog: a streaming turn never stalls, only a
      // frozen screen counts down. Inert unless a turn is in flight — a late repaint on a finished turn
      // must not re-arm a dead deadline.
      if (state === 'in-flight') deps.armTimer();
    },
    onStall() {
      // §27.12 — silence for the whole stall window: a frozen instance or an agent waiting on the human.
      // Re-injecting helps neither, so summon the human; a turn whose prompt went in stays resumable by its
      // own done-signal.
      if (state !== 'in-flight') return;
      deps.cancelTimer();
      setState('error');
      stalled = !awaitingInjectable;
      deps.writeError(
        awaitingInjectable
          ? 'stalled: the hosted agent never became injectable'
          : 'stalled: no terminal activity — if the agent is waiting on you, answer it; the turn completes when it writes its done file',
        stalled,
      );
    },
    markComplete() {
      if (state !== 'in-flight') return;
      // Unlike a done-signal (the agent's claim, worth one retry), this is the operator's. Re-injecting
      // the prompt would re-run the turn they asked to move past, so a missing artifact stops in `error`
      // (§27.12) — visible, and recoverable through Retry.
      const shortfall = deps.completionShortfall();
      if (shortfall === null) {
        succeed();
        return;
      }
      deps.cancelTimer();
      setState('error');
      deps.writeError(`marked complete but ${shortfall}`);
    },
    release() {
      stalled = false;
    },
    state() {
      return state;
    },
    stalled() {
      return state === 'error' && stalled;
    },
    transitions() {
      return transitions;
    },
  };
}
