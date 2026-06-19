// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { setShown, setCollapsed } from '../../src/renderer/src/visibility';

// The reusable accessible show/hide helpers (§22.2). The CSS enforcement ([hidden] →
// display:none !important, .is-collapsed → visibility:hidden) is verified in the e2e tab-order
// tests; here we pin the DOM contract the helpers expose.
describe('accessible visibility helpers (§22.2)', () => {
  it('setShown drives the hidden attribute (display:none is enforced in CSS)', () => {
    const el = document.createElement('div');
    setShown(el, false);
    expect(el.hidden).toBe(true);
    setShown(el, true);
    expect(el.hidden).toBe(false);
  });

  it('setCollapsed toggles the is-collapsed class (visibility:hidden in CSS)', () => {
    const el = document.createElement('div');
    setCollapsed(el, true);
    expect(el.classList.contains('is-collapsed')).toBe(true);
    setCollapsed(el, false);
    expect(el.classList.contains('is-collapsed')).toBe(false);
  });
});
