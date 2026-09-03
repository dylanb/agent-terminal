import { describe, expect, it } from 'vitest';
import {
  EPIC_SUBTICKET_LABEL,
  GROOMED_TICKET_ARTIFACT_ID,
  composeSubTicketBody,
  exampleSubTicketBody,
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

  it('keeps a plan slice that itself contains a --- rule and an Epic: line — the footer is the LAST', () => {
    const slice = 'Context\n\n---\n\nEpic: this word appears in the prose\n\nPlan: ship it.';
    const body = composeSubTicketBody(slice, { epic: 42, preceding: null });
    const r = reconstructSubTicketGroomedTicket(body);
    expect(r.ok && r.groomedTicket).toBe(slice);
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
