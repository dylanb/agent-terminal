import { describe, expect, it } from 'vitest';
import { sameFlowOccurrence } from '../../src/main/flowOccurrence';

// The flow-occurrence identity is the tuple every deferred/async flow effect re-checks so an effect scheduled
// for one entry never lands on a step/status/issue the flow has since moved to. Pinning the comparison here is
// what lets the coordinator's staleness guard and the sub-ticket skip share ONE definition (CLAUDE.md
// shared-semantics) — a mutant that drops any field from the comparison fails a case below.
describe('sameFlowOccurrence — the flow-entry identity comparison', () => {
  const base = { token: 7, stepId: 'groom', ticket: 501 } as const;

  it('is true only when token, stepId and ticket all match', () => {
    expect(sameFlowOccurrence(base, { token: 7, stepId: 'groom', ticket: 501 })).toBe(true);
  });

  it('is false when the live token differs (the entry was superseded)', () => {
    expect(sameFlowOccurrence(base, { token: 8, stepId: 'groom', ticket: 501 })).toBe(false);
  });

  it('is false when the live token is absent (no entry owns the repo)', () => {
    expect(sameFlowOccurrence({ token: undefined, stepId: 'groom', ticket: 501 }, base)).toBe(false);
  });

  it('is false when the step differs (the flow advanced)', () => {
    expect(sameFlowOccurrence(base, { token: 7, stepId: 'plan-bundle', ticket: 501 })).toBe(false);
  });

  it('is false when the ticket differs — including number vs null', () => {
    expect(sameFlowOccurrence(base, { token: 7, stepId: 'groom', ticket: 502 })).toBe(false);
    expect(sameFlowOccurrence(base, { token: 7, stepId: 'groom', ticket: null })).toBe(false);
  });

  it('is true for a ticket-less occurrence when both sides are null', () => {
    expect(sameFlowOccurrence({ token: 3, stepId: 's', ticket: null }, { token: 3, stepId: 's', ticket: null })).toBe(true);
  });
});
