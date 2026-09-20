// A2 (#133) §18.7.4 — the semantic run-started-ness accessor: it reduces a worktree's durable progression to
// the shared StartednessSignal the pointer-write gate, definition resolution, and A3's picker-enable read (the
// "raw durable started-ness" contract, distinct from the load-maskable display status).
//
// TODO(#133 write-gate GREEN): read the flow-state progression (byte-bounded, confined) and classify —
// in_progress/done (or a not_started record whose durable disposition marker is present) -> 'started'; absent /
// title-only / disposition-absent not_started -> 'never-started'; unreadable / unparseable / schema-invalid /
// over-cap -> 'indeterminate' (fail CLOSED, never 'never-started', §18.7.4/CWE-841). This stub reports
// never-started for every worktree, so the RED fails on the begun and indeterminate cases.

import { type StartednessSignal } from '../shared/flowStarted';

export function worktreeStartedness(_worktreeDir: string): StartednessSignal {
  return 'never-started';
}
