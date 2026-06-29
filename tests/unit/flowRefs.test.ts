import { describe, expect, it } from 'vitest';
import { hasFlowRefs } from '../../src/shared/ipc';

// One shared predicate so main (computeRefs) and every renderer consumer agree on what counts as
// renderable refs (CLAUDE.md shared-semantics) — an empty object must never open a panel.
describe('hasFlowRefs — renderable-refs predicate', () => {
  it('is true when a ticket or a pr is present', () => {
    expect(hasFlowRefs({ ticket: 25 })).toBe(true);
    expect(hasFlowRefs({ pr: 29 })).toBe(true);
    expect(hasFlowRefs({ ticket: 25, pr: 29 })).toBe(true);
  });
  it('is false for an empty object or undefined', () => {
    expect(hasFlowRefs({})).toBe(false);
    expect(hasFlowRefs(undefined)).toBe(false);
  });
});
