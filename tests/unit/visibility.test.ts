// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { setShown, setCollapsed } from '../../src/renderer/src/visibility';

// §22.2 accessible show/hide helpers. The CSS enforcement ([hidden], .is-collapsed) is verified in the
// e2e tab-order tests; this unit pins only the DOM contract the helpers set.
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
