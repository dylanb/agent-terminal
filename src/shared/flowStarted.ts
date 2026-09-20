// §18.7.4 — the run started-ness vocabulary shared across the processes that must agree on it (the
// loopStatus.ts precedent): the main-side write gate, definition resolution, and A3's renderer
// picker-enable all classify this one signal, so it has a single definition and cannot drift.
export type StartednessSignal = 'never-started' | 'started' | 'indeterminate';

// §18.7.4 AC7 — the one predicate the main-side pointer-write gate and A3's picker-enable classify the raw
// signal through, so "is a new selection locked" has a single definition both processes import and cannot drift.
// Fails CLOSED: 'started' AND 'indeterminate' both lock a new selection — an attacker who corrupts the
// progression to 'indeterminate' must not thereby unlock the gate (CWE-841); only 'never-started' permits one.
export function isSelectionLocked(signal: StartednessSignal): boolean {
  return signal !== 'never-started';
}
