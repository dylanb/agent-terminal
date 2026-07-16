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
import { resolveLoopDefV2, type LoopDefV2Context } from './loopDefV2';

/** The run-less/failure status strings the §27 provider emits (§27-owned, mapped to a tone by the strip;
 *  never a §26 vocabulary term). `error` reuses the existing loop-error surface so the reason row renders. */
export const APP_LOOP_STATUS_RUN_LESS = 'not-started';
export const APP_LOOP_STATUS_ERROR = 'error';

export function deriveAppLoopView(name: string, ctx: LoopDefV2Context): FlowLoopView {
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
