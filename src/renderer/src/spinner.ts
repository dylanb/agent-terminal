// The §26 activity spinner: a decorative braille glyph that animates via CSS (`tokens.css` `.spin`,
// which freezes to a static glyph under `prefers-reduced-motion`). It conveys no information on its own —
// the activity phrase beside it does — so it is `aria-hidden` (WCAG 1.3.1: no meaning carried by the
// animation alone). An atom (UI-STANDARDS §3): built from the passed `doc` so it relocates unchanged.

/** Create the animated braille spinner element. Decorative — hidden from assistive tech. */
export function createSpinner(doc: Document): HTMLElement {
  const el = doc.createElement('span');
  el.className = 'spin';
  el.setAttribute('aria-hidden', 'true');
  return el;
}
