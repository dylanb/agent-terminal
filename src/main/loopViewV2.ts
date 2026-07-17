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
import { readAppLoopState } from './appLoopState';

/** The run-less/failure status strings the §27 provider emits (§27-owned, mapped to a tone by the strip;
 *  never a §26 vocabulary term). `error` reuses the existing loop-error surface so the reason row renders. */
export const APP_LOOP_STATUS_RUN_LESS = 'not-started';
export const APP_LOOP_STATUS_ERROR = 'error';
/** The live §27 work-turn statuses the provider mirrors from the persisted run state (§27.12). Equal to the
 *  `AppLoopRunState` status values (appLoopState.ts) — one vocabulary the writer and this reader share. */
export const APP_LOOP_STATUS_WORKING = 'working';
export const APP_LOOP_STATUS_COMPLETE = 'complete';

export function deriveAppLoopView(name: string, ctx: LoopDefV2Context): FlowLoopView {
  // §27.12 — once a work turn has run, the persisted §27 run-state is the live view: mirror its status
  // (working/error/complete) and carry the turn identity the route-out acts on. `error` is classified
  // human-needed by the shared predicate so both engines agree. A run-state for a DIFFERENT loop (a stale
  // prior binding) is not this step's, so it falls through to the resolve-time run-less/failure view.
  const run = readAppLoopState(ctx.repoDir);
  if (run && run.loop === name) {
    return {
      status: run.status,
      pr: null,
      branch: null,
      ready: false,
      actionable: false,
      humanNeeded: isHumanNeededStatus(run.status),
      appTurn: { step: run.step, turnKey: run.turnKey },
      ...(run.errorReason ? { errorReason: run.errorReason } : {}),
    };
  }
  const r = resolveLoopDefV2(name, ctx);
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
  const gateOptions = r.def.gate.map((g) => g.option);
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
