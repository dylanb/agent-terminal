// §28.7/§27.10 — the sub-ticket body grammar. The promotion WRITER (epicPromotion) and the pickup READER (N10)
// both derive the compose↔reconstruct pair from here, so a change to one cannot desync the other (CLAUDE.md
// writer↔reader shared-semantics).

/** The label promotion applies to every sub-ticket and pickup keys on to detect one (§27.10 / §28.7). */
export const EPIC_SUBTICKET_LABEL = 'agent-loop/subticket';

/** The groom producer's `work.artifact` — the discriminator pickup keys on, and the binding it materializes into. */
export const GROOMED_TICKET_ARTIFACT_ID = 'groomed-ticket';

/** True iff a loop def's `work.artifact` is the groom producer — the gate the flow uses to decide a sub-ticket
 *  pickup reconstructs-and-skips groom rather than running it (§27.10 / §28.7 N10). */
export function isGroomedTicketProducer(artifactId: string): boolean {
  return artifactId === GROOMED_TICKET_ARTIFACT_ID;
}

// `Epic:` is distinct from the plan grammar's `Depends on:` (which the slice already carries) so the two never collide.
const SUBTICKET_FOOTER_DELIM = '---';
const EPIC_LINK_TOKEN = 'Epic:';
const PRECEDING_SUBTICKET_TOKEN = 'Preceding sub-ticket:';

// The exact head of the appended footer. The reader finds its LAST occurrence, so a `---`/`Epic:` the authored
// plan slice itself contains never shadows the real (always-trailing) machine footer.
const FOOTER_HEAD = `\n${SUBTICKET_FOOTER_DELIM}\n${EPIC_LINK_TOKEN} `;

/** Compose the body promotion posts for a sub-ticket: the verbatim plan slice, then the machine footer carrying the
 *  epic link and the preceding slice's issue number (`none` for the first). */
export function composeSubTicketBody(planSlice: string, refs: { epic: number; preceding: number | null }): string {
  const preceding = refs.preceding === null ? 'none' : `#${refs.preceding}`;
  return `${planSlice}\n\n${SUBTICKET_FOOTER_DELIM}\n${EPIC_LINK_TOKEN} #${refs.epic}\n${PRECEDING_SUBTICKET_TOKEN} ${preceding}\n`;
}

export type SubTicketReconstruct =
  | { ok: true; groomedTicket: string }
  | { ok: false; reason: string };

/** Recover the groomed-ticket artifact from a posted sub-ticket body: everything above the machine footer. A body
 *  missing the footer, or carrying no content above it, yields `ok: false` so pickup creates nothing and surfaces
 *  why (§27.10 — a body malformed where reconstruction reads it reconstructs no half-state). */
export function reconstructSubTicketGroomedTicket(body: string): SubTicketReconstruct {
  const idx = body.lastIndexOf(FOOTER_HEAD);
  if (idx < 0) {
    return { ok: false, reason: 'this sub-ticket has no epic-promotion machine footer, so its groomed ticket cannot be reconstructed from the body' };
  }
  const groomedTicket = body.slice(0, idx).trimEnd();
  if (groomedTicket.length === 0) {
    return { ok: false, reason: 'this sub-ticket carries no groomed-ticket content above its epic-promotion machine footer' };
  }
  return { ok: true, groomedTicket };
}

/** The one canonical example the parser test pins as reconstructable, so the grammar and its example cannot drift. */
export function exampleSubTicketBody(): string {
  const slice = [
    '### Sub-ticket 1 — the thin vertical slice',
    'Acceptance criteria: the slice is observably delivered end to end',
    '',
    'Plan: build the smallest real end-to-end increment.',
  ].join('\n');
  return composeSubTicketBody(slice, { epic: 176, preceding: null });
}
