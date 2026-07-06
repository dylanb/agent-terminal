// §26.3/D47a + D48 — the in-app turn-runner state machine for ONE actor turn. It owns no I/O: every
// effect is a domain port the host wires to the §9.3 injector, the §8.3 quiescence signal, the artifact
// check, and the state.yaml writer (the CLAUDE.md domain-port seam — the runner names what it needs, not
// the backing mechanism).

import type { AgentState } from '../shared/ipc';

export type TurnState = 'idle' | 'in-flight' | 'complete' | 'error';

/** The branch a completed consolidate turn takes on its normalized verdict (§26.6 / §26.8 / §26.13 L4/L6):
 *  a `clean` verdict STOPs the loop at the phase's post-clean human gate; `needs-work` re-iterates unless a
 *  triage condition holds, which STOPs it at the phase's post-needs-work (triage) gate instead. */
export type ConsolidateOutcome =
  | { kind: 'gate'; status: string }
  | { kind: 'reiterate'; nextIteration: number };

/** The inputs the post-consolidate branch reads (§26.6/§26.8). `stuck` is the signature-x2 flag (§26.8);
 *  `iterationCap` of 0 means the def names no cap (never at cap). */
export interface ConsolidateInputs {
  verdict: 'clean' | 'needs-work';
  iteration: number;
  postCleanGate: string;
  postNeedsWorkGate: string;
  phase2Active: boolean;
  iterationCap: number;
  stuck: boolean;
}

/** Decide the post-consolidate branch (§26.6/§26.8). `clean` → the phase's post-clean gate (STOP).
 *  `needs-work` → the phase's post-needs-work TRIAGE gate (STOP) when phase-2 is active, the iteration cap
 *  is reached, or the run is flagged stuck (signature x2); otherwise the next iteration. A triage
 *  condition with no named triage gate falls back to re-iteration (never STOP on an empty status). Pure so
 *  the host's turn-chaining glue is driven by a tested decision. */
export function decideConsolidateOutcome(inputs: ConsolidateInputs): ConsolidateOutcome {
  if (inputs.verdict === 'clean') return { kind: 'gate', status: inputs.postCleanGate };
  const atCap = inputs.iterationCap > 0 && inputs.iteration >= inputs.iterationCap;
  const triage = inputs.stuck || inputs.phase2Active || atCap;
  if (triage && inputs.postNeedsWorkGate !== '') return { kind: 'gate', status: inputs.postNeedsWorkGate };
  return { kind: 'reiterate', nextIteration: inputs.iteration + 1 };
}

/** The hosted instance's state relative to injection (§26.2), in the runner's own vocabulary — a domain
 *  concept, NOT a shell-busy check (the agent is itself the foreground process):
 *    'idle'   — a hosted agent is at its own input box and quiescent (§8.3): inject now.
 *    'busy'   — a hosted agent is present but mid-turn: defer until `onInjectable()`.
 *    'absent' — no hosted agent at the prompt (a bare shell): NEVER inject. Injecting would type the whole
 *               prompt into the shell (the motivating leak); the run stops in `error` instead (D48). */
export type HostedAgentState = 'idle' | 'busy' | 'absent';

/** Map presence + activity to injection-readiness (§26.2). `agentPresent` is the host-supplied domain
 *  fact "a hosted agent occupies the prompt" (vs a bare shell where an injected turn would leak); how the
 *  host derives it (§26.2 command-span state) is not this function's concern. Absent → `absent` (never
 *  inject). Present → §8.3 quiescence separates idle-at-input-box from mid-turn. Pure so the gate is tested. */
export function classifyHostedAgent(agentPresent: boolean, agentState: AgentState): HostedAgentState {
  if (!agentPresent) return 'absent';
  return agentState === 'quiet' ? 'idle' : 'busy';
}

export interface TurnRunnerDeps {
  /** The prompt for `turnKey` (recipe body + done-signal instruction); null = unrecoverable config error. */
  compose(turnKey: string): string | null;
  /** Inject + submit the prompt into the hosted instance (§9.3). */
  inject(prompt: string): void;
  /** The hosted instance's injection-readiness (§26.2) — see `HostedAgentState`. `absent` is the guard that
   *  keeps a prompt from ever leaking into a bare shell: it errors rather than injecting or deferring. */
  hostedAgent(): HostedAgentState;
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
  /** Begin a turn; injects now if the hosted agent is idle, defers if busy, errors if absent (§26.2). */
  requestTurn(turnKey: string): void;
  /** The instance may have become injectable (a §8.3 quiet flip) — re-evaluate a pending/retry turn: inject
   *  if now idle, keep waiting if still busy, or error if the agent has left the prompt (§26.2). */
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
    const agent = deps.hostedAgent();
    if (agent === 'absent') {
      // §26.2 — no hosted agent at the prompt (a bare shell). Injecting now would type the whole prompt
      // into the shell (the motivating defect). Never inject, never defer waiting for an agent that isn't
      // there: stop in `error` (human-needed, D48) so the operator is told to start Claude and retry.
      awaitingInjectable = false;
      deps.cancelTimer();
      state = 'error';
      deps.writeError('no hosted agent at the prompt');
      return;
    }
    if (agent === 'busy') {
      awaitingInjectable = true;
      // Bound only a RETRY that cannot re-inject (a prior attempt was already spent) so an instance that
      // never returns to injectable after a failed turn resolves to `error` (§26.3/D48) instead of
      // hanging. A turn's FIRST wait for injectability is the happy path (e.g. the work→reviewers chain
      // waiting out the instance's post-turn quiescence) and is left unbounded — bounding it would race
      // quiescence-detection latency under load.
      if (attempts > 0) deps.armTimer();
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
    tryInject();
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
      if (state === 'in-flight') return;
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
      // A deadline reached while still waiting to inject means the instance never became injectable —
      // a retry cannot help, so stop in `error` directly rather than looping the defer (§26.3/D48).
      if (awaitingInjectable) {
        deps.cancelTimer();
        state = 'error';
        deps.writeError('completion timeout: instance never became injectable');
        return;
      }
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
