// The human-readable "what the loop mechanics are doing right now" descriptor (§24.2.2 / §27.10). One
// shared definition — the main-process bootstrap producer and the renderer both key off THIS vocabulary,
// so they cannot drift (CLAUDE.md shared-semantics rule; the sibling of occurrence.ts / loopStatus.ts).

/** The distinct loop-mechanics activities a phrase can describe. */
export type LoopActivityKind = 'pickup';

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
  }
}

/** Build the descriptor for `kind` — the loop mechanics are actively doing this. */
export function loopActivity(kind: LoopActivityKind, ctx?: LoopActivityContext): LoopActivity {
  return { phrase: loopActivityPhrase(kind, ctx) };
}

/** The live loop state the descriptor is derived from: an in-flight bootstrap. */
export interface LoopActivityInputs {
  pickup: { issue: number; wipe: boolean } | null;
}

/** Derive the current activity descriptor, or null when the loop mechanics are idle (no bootstrap in
 *  flight). Pure: the decision is tested, not the rendering of it. */
export function deriveLoopActivity(inputs: LoopActivityInputs): LoopActivity | null {
  if (inputs.pickup) return loopActivity('pickup', { issue: inputs.pickup.issue, wipe: inputs.pickup.wipe });
  return null;
}
