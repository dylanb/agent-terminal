// A2 (#133) §18.7.4 — the semantic run-started-ness accessor: it reduces a worktree's durable progression to
// the shared StartednessSignal the pointer-write gate, definition resolution, and A3's picker-enable read (the
// "raw durable started-ness" contract, distinct from the load-maskable display status). It reads the
// progression through flowState's one confined reader, so this safety-gate read is path-jailed the same way the
// store's is and the two cannot drift (§18.7.4/CWE-59).
//
// TODO(#133 write-gate GREEN): compose the durable run-disposition marker's presence (revertStep keeps a
// not_started record locked) and the byte cap (an over-cap valid record -> 'indeterminate') once runDisposition
// and flowState's bounded reader land — each authored RED-first in its slice.

import { type StartednessSignal } from '../shared/flowStarted';
import { isPersistableStatus, loadFlowStateDoc } from './flowState';
import type { FlowStatus } from '../shared/ipc';

const BEGUN: ReadonlySet<FlowStatus> = new Set(['in_progress', 'done']);

export function worktreeStartedness(worktreeDir: string): StartednessSignal {
  const loaded = loadFlowStateDoc(worktreeDir);
  // Fail CLOSED on an unverifiable progression — unreadable, unparseable, or a path that escapes the jail — so a
  // corrupted flow-state cannot masquerade as never-started and unlock a new selection (§18.7.4/CWE-841).
  if (loaded.kind === 'invalid') return 'indeterminate';
  if (loaded.kind === 'missing') return 'never-started';
  const { step, status } = loaded.doc;
  // §18.7.4 rule 166's three cases. Case (iii): a valid decoded progression — a persisted step AND a persistable
  // status, the pair `flowState.decode` accepts — reads its status. Case (i) fail-open is scoped to a
  // genuinely-never-begun doc: absent (above) or title-only, carrying NEITHER a step nor a status. Every other
  // present-but-decode-invalid progression is case (ii) and fails CLOSED to 'indeterminate' — a step without a
  // status, a status outside the persistable vocabulary, AND a doc that kept a begun `status` but lost its `step`
  // to a truncated write (§18.7.4 line 167: the store collapses a post-`in_progress` corruption the same way as a
  // never-written doc). Falling open on a begun-status/step-absent doc would unlock a new pointer selection on a
  // begun-but-corrupt run — the CWE-841 fail-open this accessor exists to prevent.
  if (typeof step === 'string' && step.length > 0 && isPersistableStatus(status)) {
    return BEGUN.has(status) ? 'started' : 'never-started';
  }
  if (step === undefined && status === undefined) return 'never-started';
  return 'indeterminate';
}
