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

export function loopGateDecidable<V extends Pick<FlowLoopView, 'actionable' | 'appTurn' | 'gateOptions'>>(
  view: V,
): view is V & { appTurn: NonNullable<FlowLoopView['appTurn']>; gateOptions: string[] } {
  return view.appTurn !== undefined && (view.gateOptions?.length ?? 0) > 0 && loopGateActionable(view);
}

export const LOOP_STATUS_ERROR = 'error';

export function loopRouteOutTurn(view: Pick<FlowLoopView, 'status' | 'appTurn'>): NonNullable<FlowLoopView['appTurn']> | null {
  return view.status === LOOP_STATUS_ERROR && view.appTurn !== undefined ? view.appTurn : null;
}

export function shownErrorReason(view: Pick<FlowLoopView, 'errorReason'>): string | null {
  return view.errorReason ? stripDisplayControlChars(view.errorReason) : null;
}

export function shownVerdictRows(view: Pick<FlowLoopView, 'verdict' | 'verdictReason'>): { key: 'loopVerdict' | 'loopVerdictReason'; label: string; value: string | null }[] {
  const row = (key: 'loopVerdict' | 'loopVerdictReason', label: string, value: string | undefined) => ({ key, label, value: value ? stripDisplayControlChars(value) : null });
  return [row('loopVerdict', 'verdict', view.verdict), row('loopVerdictReason', 'verdict reason', view.verdictReason)];
}
