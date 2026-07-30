// §B.5 positions 2/4/5/6 — the loop entry seam's ONE domain answer for a bound loop step: resolve the def,
// then either REFUSE (no def resolves; a declared bootstrap the def cannot satisfy; the §27 runner cannot
// accept a turn now) or READY (optionally carrying AC 5's def-migration notice). The ORDER and the decisions
// live here; the operator-facing EFFECTS — the resolver reason on the loop-error path, the deferred revert +
// push, the def tree copy — are injected, so this branching is tested at its own boundary without the flow
// machine or the filesystem (CLAUDE.md injection-seam). Positions 1 (marked binding) and 3 (missing required
// input) are the seam's own (`flowEntryActions.ts`), above this preparer, and never reach it.

import type { FlowStepDef } from './flow';
import type { LoopDefV2, LoopDefV2Result } from './loopDefV2';
import type { LoopBindingResult } from './flowEntryActions';

export interface LoopBindingPreparerDeps {
  /** Resolve the step's bound def across the tiers (§27.15). */
  resolveDef(step: FlowStepDef): LoopDefV2Result;
  /** True iff the §27 runner can accept a work turn right now (§27.10) — position 5's hoisted readiness read,
   *  above the migration so a refused entry migrates nothing. */
  canEnterWork(): boolean;
  /** Position 2 — surface the resolver's reason on the per-step loop-error path with NO revert: a surviving
   *  app-namespace step with an unresolved def keeps the step today, so reverting would be an AC 2 change. */
  refuseUnresolved(reason: string): void;
  /** Positions 4/5 — surface the reason, and schedule the deferred, identity-guarded revert + push that rolls
   *  the step back off the synchronous entry (§B.5 item 2), so the flow never sits `in_progress` with no run. */
  refuseAndRevert(reason: string): void;
  /** Position 6 — copy the resolved def into the operator tier when it resolved from the app-bundled tier
   *  (AC 5), returning its one-shot notice; `null` for any other tier or when there is nothing to say. */
  migrateIfBundled(step: FlowStepDef, resolved: { def: LoopDefV2; tierRoot: string }): string | null;
}

export function createLoopBindingPreparer(
  deps: LoopBindingPreparerDeps,
): (step: FlowStepDef) => LoopBindingResult {
  return (step) => {
    const resolved = deps.resolveDef(step);
    if (!resolved.ok) {
      deps.refuseUnresolved(resolved.reason); // position 2
      return { kind: 'refuse' };
    }
    if (step.bootstrap !== undefined && resolved.def.pickup === null) {
      // position 4 — a declared bootstrap the resolved def cannot satisfy; above the readiness read and the
      // migration, and above the (submitted) skill injection so the revert never lands on a running turn.
      deps.refuseAndRevert(`the "${step.loop ?? ''}" loop has no pickup to run, but this step is set to pick up a ticket`);
      return { kind: 'refuse' };
    }
    if (!deps.canEnterWork()) {
      // position 5 — the runner is mid-turn; refuse before migrating anything.
      deps.refuseAndRevert('the loop is already working on another step — wait for it to finish, then try again');
      return { kind: 'refuse' };
    }
    const notice = deps.migrateIfBundled(step, resolved); // position 6
    return notice !== null ? { kind: 'ready', notice } : { kind: 'ready' };
  };
}
