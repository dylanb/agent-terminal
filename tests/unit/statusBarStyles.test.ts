import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// §22.3.1 — the status bar's truncation ladder is declared entirely in CSS, so its contract lives in the
// stylesheet and is pinned here. jsdom has no layout engine, so the *rendered* consequences (the floor
// holds, the alert stays inside the bar, the bar's height never changes) are pinned by e2e instead; what
// is checkable here is the declaration the browser then acts on — and the defect this file exists to
// catch was exactly a declaration one: title and activity shipped with the SAME shrink factor, which
// makes them shed together, in proportion to their widths, rather than in the stated order.

const css = readFileSync(path.join(__dirname, '../../src/renderer/src/styles.css'), 'utf8');

function body(selector: string): string {
  const m = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`rule ${selector} not found`);
  return m[1];
}

/** The `flex-shrink` a rule declares, read out of its `flex` shorthand (`flex: grow shrink basis`). */
function shrink(selector: string): number {
  const m = body(selector).match(/(?:^|;)\s*flex\s*:\s*(\d+)\s+(\d+)\s/);
  if (!m) throw new Error(`rule ${selector} declares no flex shorthand with a shrink factor`);
  return Number(m[2]);
}

const TITLE = '\\.status-bar \\.sb-title';
const ACTIVITY = '\\.status-bar \\.sb-activity';
const ALERT = '\\.status-bar \\.sb-alert';

describe('the status bar sheds in a stated ORDER, not proportionally (§22.3.1)', () => {
  it('gives the title a dominant shrink factor, so it yields its width before the phrase yields any', () => {
    // Equal factors distribute the overflow proportionally to content width (CSS Flexbox §9.7): a long
    // title and a live phrase would ellipsize TOGETHER, which is not a ladder.
    expect(shrink(TITLE)).toBeGreaterThan(shrink(ACTIVITY));
  });

  it('sheds the activity before the alert — the thing the human must act on goes last', () => {
    expect(shrink(ACTIVITY)).toBeGreaterThan(shrink(ALERT));
  });

  it('lets the alert shrink only as the last resort, so it can never be pushed off the bar (WCAG 1.4.10)', () => {
    // A non-shrinking alert in a nowrap bar does not survive a squeeze — it OVERFLOWS the edge, which is
    // worse than truncating: the text the human must read leaves the window entirely.
    expect(shrink(ALERT)).toBeGreaterThan(0);
  });

  it('floors the title rather than letting it vanish, so a focusable control is never zero-width', () => {
    // WCAG 2.4.11 / 1.4.4: content shrunk to nothing is removed from perception, and a clipped button
    // stays in the tab order.
    expect(body(TITLE)).toMatch(/min-width\s*:\s*[1-9]/);
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
