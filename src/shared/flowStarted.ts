// §18.7.4 — the run started-ness vocabulary shared across the processes that must agree on it (the
// loopStatus.ts precedent): the main-side write gate, definition resolution, and A3's renderer
// picker-enable all classify this one signal, so it has a single definition and cannot drift.
export type StartednessSignal = 'never-started' | 'started' | 'indeterminate';
