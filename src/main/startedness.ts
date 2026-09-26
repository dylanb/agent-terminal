// A2 (#133) §18.7.4 — the semantic run-started-ness accessor: it reduces a worktree's durable progression to
// the shared StartednessSignal the pointer-write gate, definition resolution, and A3's picker-enable read (the
// "raw durable started-ness" contract, distinct from the load-maskable display status). It reads the
// progression through flowState's one confined reader, so this safety-gate read is path-jailed the same way the
// store's is and the two cannot drift (§18.7.4/CWE-59), and composes the durable run-disposition marker's
// PRESENCE (runDisposition) so a begun run whose first step is rolled back — the display status back to
// not_started — still reads 'started' and keeps a new selection locked (AC7/CWE-841).

import { type StartednessSignal } from '../shared/flowStarted';
import { isBegunStatus, type BegunStatus, type ProgressionBegunness } from '../shared/runHold';
import { isPersistableStatus, isPersistedStep, loadFlowStateDoc } from './flowState';
import { readDisposition } from './runDisposition';

export type ProgressionRead = { kind: 'begun'; step: string; status: BegunStatus } | { kind: Exclude<ProgressionBegunness, 'begun'> };

/** §18.7.4 — the durable progression alone, without the run-disposition marker. */
export function readProgression(worktreeDir: string): ProgressionRead {
  const loaded = loadFlowStateDoc(worktreeDir);
  // Fail CLOSED on an unverifiable progression — unreadable, unparseable, or a path that escapes the jail — so a
  // corrupted flow-state cannot masquerade as never-started and unlock a new selection (§18.7.4/CWE-841).
  if (loaded.kind === 'invalid') return { kind: 'indeterminate' };
  if (loaded.kind === 'missing') return { kind: 'not-begun' };
  const { step, status } = loaded.doc;
  // §18.7.4's three cases. Case (iii): a valid decoded progression — a persisted step AND a persistable
  // status, the pair `flowState.decode` accepts — reads its status. Case (i) fail-open is scoped to a
  // genuinely-never-begun doc: absent (above) or title-only, carrying NEITHER a step nor a status. Every other
  // present-but-decode-invalid progression is case (ii) and fails CLOSED to 'indeterminate' — a step without a
  // status, a status outside the persistable vocabulary, AND a doc that kept a begun `status` but lost its `step`
  // to a truncated write (§18.7.4: the store collapses a post-`in_progress` corruption the same way as a
  // never-written doc). Falling open on a begun-status/step-absent doc would unlock a new pointer selection on a
  // begun-but-corrupt run — the CWE-841 fail-open this accessor exists to prevent.
  if (isPersistedStep(step) && isPersistableStatus(status)) {
    return isBegunStatus(status) ? { kind: 'begun', step, status } : { kind: 'not-begun' };
  }
  if (step === undefined && status === undefined) return { kind: 'not-begun' };
  return { kind: 'indeterminate' };
}

export function progressionBegunness(worktreeDir: string): ProgressionBegunness {
  return readProgression(worktreeDir).kind;
}

export function worktreeStartedness(worktreeDir: string): StartednessSignal {
  const progression = progressionBegunness(worktreeDir);
  if (progression === 'indeterminate') return 'indeterminate';
  // Consult the durable marker before the display status, which it overrides: present → 'started' (survives a
  // revertStep), unverifiable → 'indeterminate'; only a genuinely absent marker defers to the progression
  // (§18.7.4/CWE-841).
  const disposition = readDisposition(worktreeDir);
  if (disposition === 'indeterminate') return 'indeterminate';
  if (disposition === 'present') return 'started';
  return progression === 'begun' ? 'started' : 'never-started';
}
