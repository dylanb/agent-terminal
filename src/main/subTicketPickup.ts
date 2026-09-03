// §27.10/§28.7 N10 — picking up an epic sub-ticket. A ticket carrying EPIC_SUBTICKET_LABEL reconstructs its
// groomed-ticket artifact from the issue body (the plan slice promotion posted verbatim, §28.7) and SKIPS the
// groom step; the flow lands at plan-bundle, which re-plans this slice's own seams (§28 P7a). A normal ticket is
// untouched. Pure orchestration over injected domain concepts — the real gh read, artifact write, flow advance and
// error surface are wired in index.ts and covered by the pickup e2e (CLAUDE.md injection-seam-is-a-concept).

import { EPIC_SUBTICKET_LABEL, reconstructSubTicketGroomedTicket } from '../shared/epicSubTicket';

export interface SubTicketPickupDeps {
  /** The picked-up issue's body + labels, or null when it cannot be read (treated as "not a sub-ticket"). */
  readIssue(issue: number): Promise<{ body: string; labels: string[] } | null>;
  /** Materialize the reconstructed groomed-ticket artifact into the loop area (the groom producer's output path). */
  writeGroomedTicket(content: string): void;
  /** Advance the flow past groom to plan-bundle (§27.10 "advances … without running groom"). */
  advancePastGroom(): void;
  /** Surface why a sub-ticket body could not be reconstructed, so the operator can fix it (§27.10 fail-visible). */
  surfaceError(reason: string): void;
}

export type SubTicketPickupOutcome =
  | { kind: 'not-subticket' }
  | { kind: 'skipped' }
  | { kind: 'malformed' };

/** Reconstruct-and-skip for an epic sub-ticket pickup. `not-subticket` leaves the caller's normal groom path
 *  untouched; `skipped` materialized the groomed ticket and advanced; `malformed` surfaced why and advanced
 *  nothing (§27.10 — a body malformed where reconstruction reads it reconstructs no half-state). */
export async function runSubTicketPickup(deps: SubTicketPickupDeps, issue: number): Promise<SubTicketPickupOutcome> {
  const info = await deps.readIssue(issue);
  if (info === null || !info.labels.includes(EPIC_SUBTICKET_LABEL)) return { kind: 'not-subticket' };
  const reconstructed = reconstructSubTicketGroomedTicket(info.body);
  if (!reconstructed.ok) {
    deps.surfaceError(reconstructed.reason);
    return { kind: 'malformed' };
  }
  deps.writeGroomedTicket(reconstructed.groomedTicket);
  deps.advancePastGroom();
  return { kind: 'skipped' };
}
