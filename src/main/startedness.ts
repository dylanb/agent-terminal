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
  const { status } = loaded.doc;
  // An absent `status` is the legitimate never-named/title-only worktree; a status present but outside the
  // persistable vocabulary (which flowState.decode rejects identically) is a schema-invalid progression that
  // fails CLOSED to 'indeterminate', never 'never-started' (§18.7.4/CWE-841).
  if (status === undefined) return 'never-started';
  if (!isPersistableStatus(status)) return 'indeterminate';
  return BEGUN.has(status) ? 'started' : 'never-started';
}
