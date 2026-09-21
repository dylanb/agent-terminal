// A2 (#133) §18.7.4 AC7 — the active-flow write gate: a new selection is permitted only while the run has never
// started, and refused once it has begun or (fail-closed, CWE-841) while begun-ness is indeterminate. Composes
// the shared started-ness accessor and the shared lock predicate so the gate and A3's picker-enable cannot
// diverge on "is a new selection locked". A write fault rolls back to the prior on-disk selection (writeActiveFlow
// is atomic) and surfaces a reason, never an unrecoverable state (CODE-STANDARDS.md).
import { writeActiveFlow } from './activeFlowPointer';
import { worktreeStartedness } from './startedness';
import { isSelectionLocked } from '../shared/flowStarted';
import { errMsg } from './errno';
import type { ActiveFlowWriteResult } from '../shared/ipc';

export function setActiveFlowGated(worktreeDir: string, id: string): ActiveFlowWriteResult {
  const startedness = worktreeStartedness(worktreeDir);
  if (isSelectionLocked(startedness)) {
    return {
      ok: false,
      reason:
        startedness === 'indeterminate'
          ? "This worktree's run state could not be verified, so a new flow selection is refused; recover the run before selecting a flow."
          : "This worktree's run has begun; a new flow selection is locked until you Terminate the run.",
    };
  }
  try {
    writeActiveFlow(worktreeDir, id);
  } catch (e) {
    return { ok: false, reason: `The flow selection could not be saved: ${errMsg(e)}` };
  }
  return { ok: true };
}
