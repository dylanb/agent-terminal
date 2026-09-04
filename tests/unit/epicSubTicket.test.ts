import { describe, expect, it } from 'vitest';
import {
  EPIC_SUBTICKET_LABEL,
  GROOMED_TICKET_ARTIFACT_ID,
  composeSubTicketBody,
  exampleSubTicketBody,
  isGroomedTicketProducer,
  reconstructSubTicketGroomedTicket,
} from '../../src/shared/epicSubTicket';

// §28.7/§27.10 — the sub-ticket body is the one on-disk vocabulary the promotion WRITER (epicPromotion) and the
// pickup READER (N10 materialize) must agree on. This pins the compose↔reconstruct pair and the shared markers so
// a change to one side cannot silently desync the other (CLAUDE.md writer↔reader shared-semantics).
describe('§28.7/§27.10 epicSubTicket — the sub-ticket body writer↔reader grammar', () => {
  it('single-sources the promotion marker and the groomed-ticket artifact id both sides key on', () => {
    expect(EPIC_SUBTICKET_LABEL).toBe('agent-loop/subticket');
    expect(GROOMED_TICKET_ARTIFACT_ID).toBe('groomed-ticket');
  });

  it('reconstruct recovers verbatim the plan slice a compose wrote (the round-trip)', () => {
    const slice = '### Ticket\n\nAcceptance criteria: it works\n\nPlan: build the thin slice.';
    const body = composeSubTicketBody(slice, { epic: 176, preceding: 501 });
    const r = reconstructSubTicketGroomedTicket(body);
    expect(r.ok).toBe(true);
    expect(r.ok && r.groomedTicket).toBe(slice);
  });

  it('keeps a plan slice that itself embeds the machine footer markers — reconstruct strips only the LAST', () => {
    // The authored slice contains a real `\n---\nEpic: ` line (single newlines, the exact footer head), so the
    // composed body carries TWO occurrences. reconstruct must strip only the LAST (the footer promotion appended)
    // and return the slice verbatim; an `indexOf` reader would stop at the embedded one and truncate to 'Context'.
    const slice = 'Context\n---\nEpic: #999 mentioned in the plan prose\n\nPlan: ship it.';
    const body = composeSubTicketBody(slice, { epic: 42, preceding: null });
    const r = reconstructSubTicketGroomedTicket(body);
    expect(r.ok && r.groomedTicket).toBe(slice);
  });

  it('reconstruct stays linear on a pathological trailing-whitespace slice (ReDoS regression)', () => {
    // A plan slice that is a huge whitespace run before a single non-space char makes `/\s+$/` backtrack
    // quadratically (measured ~1.4s at 50k, freezing the main process); `.trimEnd()` is linear (~microseconds).
    // The body is a valid sub-ticket (non-empty above the footer), so reconstruction actually runs the strip.
    const slice = ' '.repeat(50000) + 'x';
    const body = composeSubTicketBody(slice, { epic: 1, preceding: null });
    const t0 = performance.now();
    const r = reconstructSubTicketGroomedTicket(body);
    const ms = performance.now() - t0;
    expect(r.ok && r.groomedTicket).toBe(slice);
    expect(ms).toBeLessThan(500);
  });

  it('isGroomedTicketProducer is true only for the groom producer artifact id (the skip gate discriminator)', () => {
    expect(isGroomedTicketProducer(GROOMED_TICKET_ARTIFACT_ID)).toBe(true);
    expect(isGroomedTicketProducer('plan-bundle')).toBe(false);
    expect(isGroomedTicketProducer('')).toBe(false);
  });

  it('fails (creates nothing) on a sub-ticket body missing the machine footer', () => {
    const r = reconstructSubTicketGroomedTicket('a body with no machine footer at all');
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason.length).toBeGreaterThan(0);
  });

  it('fails on an empty plan slice above the footer', () => {
    const body = composeSubTicketBody('   ', { epic: 1, preceding: null });
    expect(reconstructSubTicketGroomedTicket(body).ok).toBe(false);
  });

  it('the canonical example body is reconstructable (the shared-semantics example pin)', () => {
    const r = reconstructSubTicketGroomedTicket(exampleSubTicketBody());
    expect(r.ok).toBe(true);
    expect(r.ok && r.groomedTicket.length).toBeGreaterThan(0);
  });
});
