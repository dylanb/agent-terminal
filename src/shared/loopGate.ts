// One definition of "are this loop view's gate options actionable" (§27 IPC item 1), imported by the
// main-side loop-view providers (which SET it) and the renderer loop panel (which READS it) so the two
// cannot drift on what "actionable" means. An awaiting-gate view is actionable — the human clicks an
// option to decide the gate; a §27 run-less view populates the same gateOptions field display-only. The
// guard that a §27 gate decision never executes lives at the operation, not here — this only decides
// whether the panel renders clickable controls.

import type { FlowLoopView } from './ipc';
import { stripDisplayControlChars } from './controlChars';

/** True when the view's gate options may be acted on (clickable decision controls). A producing engine
 *  marks a view display-only by opting in — setting `actionable: false` (the §27 run-less view); anything
 *  that does not opt in is actionable, so every hand-constructed awaiting-gate view keeps its controls. */
export function loopGateActionable(view: Pick<FlowLoopView, 'actionable'>): boolean {
  return view.actionable !== false;
}

/** The loop gate the panel renders decision controls for: a decidable turn, options the def offers, and options
 *  that may be acted on. `read_state` reports exactly this gate, so the agent and the operator see the same one. */
export function loopGateDecidable<V extends Pick<FlowLoopView, 'actionable' | 'appTurn' | 'gateOptions'>>(
  view: V,
): view is V & { appTurn: NonNullable<FlowLoopView['appTurn']>; gateOptions: string[] } {
  return view.appTurn !== undefined && (view.gateOptions?.length ?? 0) > 0 && loopGateActionable(view);
}

/** The status of a loop view whose work turn failed. */
export const LOOP_STATUS_ERROR = 'error';

/** The failed work turn the loop panel offers its route-out (Retry, accept, Terminate) for, or null. `read_state`
 *  reports exactly this turn, so the agent and the operator see the same one. */
export function loopRouteOutTurn(view: Pick<FlowLoopView, 'status' | 'appTurn'>): NonNullable<FlowLoopView['appTurn']> | null {
  return view.status === LOOP_STATUS_ERROR && view.appTurn !== undefined ? view.appTurn : null;
}

/** A failed turn's reason as the loop panel's reason row shows it, or null where the panel shows no reason row. */
export function shownErrorReason(view: Pick<FlowLoopView, 'errorReason'>): string | null {
  return view.errorReason ? stripDisplayControlChars(view.errorReason) : null;
}

/** The verdict rows the gate panel shows: the round's verdict and, under `stop for a human`, its reason. `value` is
 *  null for a row the panel does not show, and otherwise stripped of display-unsafe characters (CWE-117). */
export function shownVerdictRows(view: Pick<FlowLoopView, 'verdict' | 'verdictReason'>): { key: 'loopVerdict' | 'loopVerdictReason'; label: string; value: string | null }[] {
  const row = (key: 'loopVerdict' | 'loopVerdictReason', label: string, value: string | undefined) => ({ key, label, value: value ? stripDisplayControlChars(value) : null });
  return [row('loopVerdict', 'verdict', view.verdict), row('loopVerdictReason', 'verdict reason', view.verdictReason)];
}
