// One definition of "are this loop view's gate options actionable" (§27 IPC item 1), imported by the
// main-side loop-view providers (which SET it) and the renderer loop panel (which READS it) so the two
// cannot drift on what "actionable" means. A §26 awaiting-gate view is actionable — the human clicks an
// option to decide the gate; a §27 run-less view populates the same gateOptions field display-only. The
// guard that a §27 gate decision never executes lives at the operation, not here — this only decides
// whether the panel renders clickable controls.

import type { FlowLoopView } from './ipc';

/** True when the view's gate options may be acted on (clickable decision controls). A producing engine
 *  marks a view display-only by setting `actionable: false` (the §27 run-less view); absence defaults to
 *  actionable, so the §26 provider and every hand-constructed awaiting-gate view keep their controls. */
export function loopGateActionable(view: Pick<FlowLoopView, 'actionable'>): boolean {
  return view.actionable !== false;
}
