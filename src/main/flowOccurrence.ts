// The identity of a flow occurrence — the tuple a deferred or async flow effect re-checks so an effect scheduled
// for one entry never lands on a step/status/issue the flow has since moved to. One definition, so the bootstrap
// coordinator's staleness guard and the sub-ticket skip cannot compare it differently (CLAUDE.md shared-semantics).

/** `token` is the live entry token owning a repo (absent when none does). */
export interface FlowOccurrenceRef {
  token: number | undefined;
  stepId: string;
  ticket: number | null;
}

export function sameFlowOccurrence(a: FlowOccurrenceRef, b: FlowOccurrenceRef): boolean {
  return a.token === b.token && a.stepId === b.stepId && a.ticket === b.ticket;
}
