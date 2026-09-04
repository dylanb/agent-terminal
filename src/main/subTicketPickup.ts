// §27.10/§28.7 N10 (§28 P7a) — sub-ticket pickup: reconstruct the groomed ticket from the issue body and skip
// groom. Pure orchestration; the gh read / artifact write / flow advance / error surface are wired in index.ts.

import { EPIC_SUBTICKET_LABEL, reconstructSubTicketGroomedTicket } from '../shared/epicSubTicket';

export interface SubTicketPickupDeps {
  /** The picked-up issue's body + labels, or null when it cannot be read (treated as "not a sub-ticket"). */
  readIssue(issue: number): Promise<{ body: string; labels: string[] } | null>;
  /** Whether this pickup is still the flow's current occurrence — false once a raced terminate/navigate moved it on. */
  isCurrent(): boolean;
  /** Materialize the reconstructed groomed-ticket artifact into the groom producer's output path. */
  writeGroomedTicket(content: string): void;
  /** Advance the flow past groom to the next step and notify the renderer (§27.10). */
  advancePastGroom(): void;
  /** Surface why the pickup produced nothing, so the operator can fix it and retry (§27.10 fail-visible). */
  surfaceError(reason: string): void;
}

export type SubTicketPickupOutcome =
  | { kind: 'not-subticket' }
  | { kind: 'skipped' }
  | { kind: 'stale' }
  | { kind: 'malformed' }
  | { kind: 'materialize-failed' };

export async function runSubTicketPickup(deps: SubTicketPickupDeps, issue: number): Promise<SubTicketPickupOutcome> {
  const info = await deps.readIssue(issue);
  if (info === null || !info.labels.includes(EPIC_SUBTICKET_LABEL)) return { kind: 'not-subticket' };
  const reconstructed = reconstructSubTicketGroomedTicket(info.body);
  if (!reconstructed.ok) {
    deps.surfaceError(reconstructed.reason);
    return { kind: 'malformed' };
  }
  if (!deps.isCurrent()) return { kind: 'stale' };
  try {
    deps.writeGroomedTicket(reconstructed.groomedTicket);
    deps.advancePastGroom();
  } catch (e) {
    deps.surfaceError(`the sub-ticket's groomed ticket could not be materialized: ${e instanceof Error ? e.message : String(e)}`);
    return { kind: 'materialize-failed' };
  }
  return { kind: 'skipped' };
}
