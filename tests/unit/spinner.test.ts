// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createSpinner } from '../../src/renderer/src/spinner';

// Activity spinner — a tiny decorative atom (the braille glyph animates via CSS in tokens.css). It
// carries NO meaning of its own (the phrase beside it does), so it is hidden from assistive tech. Built
// from the passed ownerDocument, never the global document (UI-STANDARDS §3.3 relocation).
describe('spinner atom (activity)', () => {
  it('creates a spin element that is decorative (hidden from screen readers)', () => {
    const el = createSpinner(document);
    expect(el.classList.contains('spin')).toBe(true);
    expect(el.getAttribute('aria-hidden')).toBe('true');
  });

  it('builds from the passed document, not the global one (relocation-safe)', () => {
    const foreign = document.implementation.createHTMLDocument('foreign');
    const el = createSpinner(foreign);
    expect(el.ownerDocument).toBe(foreign);
  });
});
