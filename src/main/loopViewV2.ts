// The §27 loop-view provider — the READ meeting point of the coexistence seam (§27.15), engine-selected
// on a flow step's `app` namespace. It resolves the bound app-def and owns the WHOLE loop view the strip
// and panel render, reading no §26 loop state, so a §27-bound step renders with the §26 defs and §26 loop
// state absent. Two shapes:
//   - a def that resolved before any round → a RUN-LESS view: its declared gate options, display-only
//     (actionable false — the refusal guard is at the write operation, not the render), no iteration (no
//     round has run — never a fabricated 0), not human-needed, advance gate false (§19.2 override is the
//     route on).
//   - a def that failed to resolve / parse / confine → a FAILURE view carrying the reason (AC 6),
//     human-needed so the cue and OS notifier surface it, with no round.

import type { FlowLoopView } from '../shared/ipc';
import { isHumanNeededStatus } from '../shared/loopStatus';
import { resolveLoopDefV2, type LoopDefV2Context } from './loopDefV2';
import { catalogPersonas } from './reviewTurn';
import { readAppLoopState } from './appLoopState';
import type { AppLoopEngine, AppLoopLiveError } from './appLoopEngine';

/** The run-less/failure status strings the §27 provider emits (§27-owned, mapped to a tone by the strip;
 *  never a §26 vocabulary term). `error` reuses the existing loop-error surface so the reason row renders. */
export const APP_LOOP_STATUS_RUN_LESS = 'not-started';
export const APP_LOOP_STATUS_ERROR = 'error';
/** The live §27 work-turn statuses the provider mirrors from the persisted run state (§27.12). Equal to the
 *  `AppLoopRunState` status values (appLoopState.ts) — one vocabulary the writer and this reader share. */
export const APP_LOOP_STATUS_WORKING = 'working';
export const APP_LOOP_STATUS_COMPLETE = 'complete';

export function deriveAppLoopView(name: string, ctx: LoopDefV2Context, liveError?: AppLoopLiveError | null): FlowLoopView {
  // §27.4/§27.6/AC5/AC8 — the def is resolved once and reused on every surfacing branch: the reviewer catalog
  // AND the gate options both come from it, so the terminal consolidator gate (a run-state view) can show the
  // verdict and the def's options together. Both are absent when the def does not resolve.
  const r = resolveLoopDefV2(name, ctx);
  const catalog = r.ok ? catalogPersonas(r.def) : undefined;
  const gateOptions = r.ok ? r.def.gate.map((g) => g.option) : [];
  // §27.12c — when the status:error write could not land (ENOSPC/EPERM/a planted symlink), the persisted
  // state cannot reflect the error, so the engine's LIVE error is the truth: surface it (and its route-out
  // identity) so the §27 route-out is never a dead-end. It is the freshest signal, so it wins over a stale
  // persisted status; a live error for a DIFFERENT loop is not this step's.
  if (liveError && liveError.loop === name) {
    return {
      status: APP_LOOP_STATUS_ERROR,
      pr: null,
      branch: null,
      ready: false,
      actionable: false,
      humanNeeded: isHumanNeededStatus(APP_LOOP_STATUS_ERROR),
      appTurn: { step: liveError.step, turnKey: liveError.turnKey },
      errorReason: liveError.reason,
      ...(liveError.round !== undefined ? { iteration: liveError.round } : {}),
      ...(catalog ? { catalog } : {}),
    };
  }
  // §27.12 — once a work turn has run, the persisted §27 run-state is the live view: mirror its status
  // (working/error/complete) and carry the turn identity the route-out acts on. `error` is classified
  // human-needed by the shared predicate so both engines agree. A run-state for a DIFFERENT loop (a stale
  // prior binding) is not this step's, so it falls through to the resolve-time run-less/failure view.
  const run = readAppLoopState(ctx.repoDir);
  if (run && run.loop === name) {
    // §27.9/N5 (AC1) — a terminal gate is a reached verdict with declared options; only then are options
    // clickable and the loop blocked on the human. The undeclared-option refusal stays at the operation
    // (appGateDecision validates), not here.
    const atGate = run.verdict !== undefined && gateOptions.length > 0;
    return {
      status: run.status,
      pr: null,
      branch: null,
      ready: false,
      actionable: atGate,
      humanNeeded: atGate || isHumanNeededStatus(run.status),
      appTurn: { step: run.step, turnKey: run.turnKey },
      ...(run.errorReason ? { errorReason: run.errorReason } : {}),
      // §27.5 IPC item 3 — carry the round number once a review-and-fix round has run (absent through the
      // work turn, so a coalesce-to-zero never fabricates a round identity the dedup/audit key on).
      ...(run.round !== undefined ? { iteration: run.round } : {}),
      // §27.6/AC5/AC8 — the catalog, the def's gate options, the consolidator's chosen roster, and the round's
      // verdict + reason. The gate-options preview belongs at the TERMINAL consolidator gate, not during an
      // active mid-loop turn (AC5 Non-goals), so it rides only once a verdict has been reached.
      ...(catalog ? { catalog } : {}),
      ...(atGate ? { gateOptions } : {}),
      ...(run.chosenRoster ? { chosenRoster: run.chosenRoster } : {}),
      ...(run.verdict ? { verdict: run.verdict } : {}),
      ...(run.verdictReason ? { verdictReason: run.verdictReason } : {}),
    };
  }
  if (!r.ok) {
    return {
      status: APP_LOOP_STATUS_ERROR,
      pr: null,
      branch: null,
      ready: false,
      actionable: false,
      humanNeeded: true,
      errorReason: r.reason,
    };
  }
  return {
    status: APP_LOOP_STATUS_RUN_LESS,
    pr: null,
    branch: null,
    ready: false,
    actionable: false,
    humanNeeded: false,
    ...(gateOptions.length > 0 ? { gateOptions } : {}),
  };
}

/** The flow manager's §27 loop-view provider: reconstruct a relaunch-stranded turn to routable BEFORE the
 *  live error is read, then derive the view from it + the resolved def (§27.12/§27.15). Without this a
 *  persisted `working` turn — definitionally stopped by the relaunch — mirrors to a not-human-needed view
 *  with no route-out (CWE-703/755). resume() no-ops without a §27 run-state and is skipped once a live turn
 *  for this repo is already active, so a genuinely in-flight turn is never disturbed. */
export function provideAppLoopView(
  engine: Pick<AppLoopEngine, 'activeRepoDir' | 'resume' | 'liveErrorFor'>,
  name: string,
  ctx: LoopDefV2Context,
): FlowLoopView {
  if (engine.activeRepoDir() !== ctx.repoDir) engine.resume(ctx.repoDir);
  return deriveAppLoopView(name, ctx, engine.liveErrorFor(ctx.repoDir));
}
