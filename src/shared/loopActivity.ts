// The human-readable "what the loop mechanics are doing right now" descriptor (§24.2.2 / §26): a short
// phrase, present exactly while the loop is active (its presence drives the strip's spinner). One shared
// definition — the main-process producer and the renderer both key off THIS vocabulary, so they cannot
// drift (CLAUDE.md shared-semantics rule; the sibling of occurrence.ts / loopStatus.ts).

/** The distinct loop-mechanics activities a phrase can describe. */
export type LoopActivityKind = 'pickup' | 'waiting' | 'work' | 'reviewers' | 'consolidate';

/** Optional facts that specialize a phrase (the bootstrapping issue; a wipe re-bootstrap). */
export interface LoopActivityContext {
  issue?: number;
  wipe?: boolean;
}

/** The descriptor surfaced on the wire (src/shared/ipc.ts FlowStateView.loopActivity). Present only while
 *  the loop mechanics are active — the descriptor's presence IS "busy"; there is no idle descriptor. */
export interface LoopActivity {
  phrase: string;
}

/** Map an activity kind (+ context) to its display phrase. Total over `LoopActivityKind`. */
export function loopActivityPhrase(kind: LoopActivityKind, ctx: LoopActivityContext = {}): string {
  switch (kind) {
    case 'pickup':
      if (ctx.wipe) return 'Retrying bootstrap';
      return ctx.issue != null ? `Bootstrapping #${ctx.issue}` : 'Bootstrapping';
    case 'waiting':
      return 'Waiting for the agent';
    case 'work':
      return 'Working';
    case 'reviewers':
      return 'Running reviewers';
    case 'consolidate':
      return 'Consolidating reviews';
  }
}

/** Build the descriptor for `kind` — the loop mechanics are actively doing this (so the strip spins). */
export function loopActivity(kind: LoopActivityKind, ctx?: LoopActivityContext): LoopActivity {
  return { phrase: loopActivityPhrase(kind, ctx) };
}

/** The live loop state the descriptor is derived from: an in-flight bootstrap, or the current turn plus
 *  whether its prompt has been injected yet (deferred → "waiting", injected → the turn phase). */
export interface LoopActivityInputs {
  pickup: { issue: number; wipe: boolean } | null;
  turn: { kind: 'work' | 'reviewers' | 'consolidate'; injected: boolean } | null;
}

/** Derive the current activity descriptor, or null when the loop mechanics are idle (at a gate, done, or
 *  between flows). A bootstrap outranks a turn (it precedes any turn); an un-injected turn is still
 *  "waiting for the agent". Pure so the strip's spinner is driven by a tested decision. */
export function deriveLoopActivity(inputs: LoopActivityInputs): LoopActivity | null {
  if (inputs.pickup) return loopActivity('pickup', { issue: inputs.pickup.issue, wipe: inputs.pickup.wipe });
  if (inputs.turn) return loopActivity(inputs.turn.injected ? inputs.turn.kind : 'waiting');
  return null;
}
