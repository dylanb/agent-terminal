// A2 (#133) §18.7.4 AC7/AC11 — the active-flow write gate: a new selection (set or clear) is permitted only while
// the run has never started, and refused once it has begun or (fail-closed, CWE-841) while begun-ness is
// indeterminate. The started-ness read and the write run under the worktree lock flow:start also takes (CWE-367); the
// lock-free window when the lock is unusable is an accepted residual (§18.7.4, v2.156). A refusal leaves the prior
// on-disk selection in place; a write fault surfaces a reason, never an unrecoverable state (CODE-STANDARDS.md).
import { clearActiveFlow, readActiveFlow, writeActiveFlow } from './activeFlowPointer';
import { worktreeStartedness } from './startedness';
import { isSelectionLocked } from '../shared/flowStarted';
import { errMsg } from './errno';
import { displaySafeEcho, MAX_ECHOED_REASON_LENGTH } from '../shared/controlChars';
import type { ActiveFlowWriteResult } from '../shared/ipc';
import type { WorktreeLock, WorktreeLockScope } from './worktreeLock';

export interface ActiveFlowGate {
  set(worktreeDir: string, id: string): ActiveFlowWriteResult;
  clear(worktreeDir: string): ActiveFlowWriteResult;
}

export type PointerWrite = { kind: 'set'; id: string } | { kind: 'unset' };

export type SelectResult =
  | { ok: true }
  | { ok: false; cause: 'run-begun'; reason: string }
  | { ok: false; cause: 'write-failed'; reason: string; error: string };

function writePointer(worktreeDir: string, write: PointerWrite): void {
  switch (write.kind) {
    case 'set':
      writeActiveFlow(worktreeDir, write.id);
      return;
    case 'unset':
      clearActiveFlow(worktreeDir);
      if (readActiveFlow(worktreeDir).kind !== 'unset') throw new Error('the saved selection could not be removed');
      return;
    default:
      return write satisfies never;
  }
}

/** The gate's check-then-write body. `withWorktreeLock` is non-reentrant across instances, so a caller already
 *  inside a lock scope calls this rather than `gate.set`/`gate.clear`. */
export function selectIfUnlocked(_scope: WorktreeLockScope, worktreeDir: string, write: PointerWrite): SelectResult {
  const startedness = worktreeStartedness(worktreeDir);
  if (isSelectionLocked(startedness)) {
    return {
      ok: false,
      cause: 'run-begun',
      reason:
        startedness === 'indeterminate'
          ? "This worktree's run state could not be verified, so a new flow selection is refused; Terminate the run before selecting a flow."
          : "This worktree's run has begun; a new flow selection is locked until you Terminate the run.",
    };
  }
  try {
    writePointer(worktreeDir, write);
  } catch (e) {
    const error = displaySafeEcho(errMsg(e), MAX_ECHOED_REASON_LENGTH);
    return { ok: false, cause: 'write-failed', reason: `The flow selection could not be saved: ${error}`, error };
  }
  return { ok: true };
}

export function createActiveFlowGate(lock: Pick<WorktreeLock, 'withWorktreeLock'>): ActiveFlowGate {
  const gated = (worktreeDir: string, write: PointerWrite): ActiveFlowWriteResult => {
    const locked = lock.withWorktreeLock(worktreeDir, (scope) => selectIfUnlocked(scope, worktreeDir, write));
    if (!locked.ok) return locked;
    const result = locked.value;
    return result.ok ? result : { ok: false, reason: displaySafeEcho(result.reason, MAX_ECHOED_REASON_LENGTH) };
  };

  return {
    set: (worktreeDir, id) => gated(worktreeDir, { kind: 'set', id }),
    clear: (worktreeDir) => gated(worktreeDir, { kind: 'unset' }),
  };
}
