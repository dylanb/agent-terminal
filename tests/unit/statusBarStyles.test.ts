import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// §22.3.1 — a few status-bar guarantees that are declared in CSS and are awkward-to-impossible to
// observe in the layout tier: a live region that must never be pruned from the a11y tree, and a spinner
// whose animation (and its reduced-motion freeze) is motion, not layout. The truncation LADDER's rendered
// behaviour — shed order, the floor, the alert staying inside the bar, the constant height — is pinned
// behaviourally by the e2e instead, so this file no longer asserts the flex-shrink spelling.

const css = readFileSync(path.join(__dirname, '../../src/renderer/src/styles.css'), 'utf8');

function body(selector: string): string {
  const m = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`rule ${selector} not found`);
  return m[1];
}

describe('nothing sheds to zero — the title and the phrase floor (§22.3.1 / decision 16)', () => {
  // The rendered floor is proven behaviourally by the e2e; here we pin only that the required min-width
  // DECLARATION exists, the one guard jsdom cannot layout and the defect (a phrase with no floor) was.
  it('floors the title so a focusable control is never clipped to zero width (WCAG 2.4.11)', () => {
    expect(body('\\.status-bar \\.sb-title')).toMatch(/min-width\s*:\s*[1-9]/);
  });

  it('floors the activity phrase so an active engine never collapses to a bare spinner', () => {
    expect(body('\\.status-bar \\.sb-activity \\.phrase')).toMatch(/min-width\s*:\s*[1-9]/);
  });
});

describe('the polite live region stays in the accessibility tree (§22.3.1)', () => {
  it('never hides the activity region while it is empty', () => {
    // `display:none` prunes a node from the a11y tree exactly as removal does, so the first phrase of a
    // run would arrive in a region that was not there to be watched — and go unannounced
    // (WCAG 4.1.3; UI-STANDARDS §4.1 forbids it in as many words).
    const empty = css.match(/\.status-bar\s+\.sb-activity:empty\s*\{([^}]*)\}/);
    expect(empty?.[1] ?? '').not.toMatch(/display\s*:\s*none|visibility\s*:\s*hidden/);
  });
});

describe('the activity spinner actually renders (§26)', () => {
  it('ships the spinner glyph in the stylesheet the app loads, not only in the design mock', () => {
    // `createSpinner` emits <span class="spin">, which has no content of its own: without a rule here it
    // is an empty, invisible box — and the ladder above leaves it standing after the phrase is shed.
    expect(css).toMatch(/\.spin::after\s*\{[^}]*content\s*:/);
  });

  it('animates it, and freezes that animation under prefers-reduced-motion (WCAG 2.2.2)', () => {
    expect(css).toMatch(/@keyframes\s+braille/);
    const reduced = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(reduced?.[1] ?? '').toMatch(/\.spin::after\s*\{[^}]*animation\s*:\s*none/);
  });
});
