// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wireCrossHighlight, type CrossHighlight } from '../../src/renderer/src/crossHighlight';

// §16.8 cross-highlight: a finding in the capture pane and its source line in the terminal share a
// data-find id; hovering either lights both, and both stay on screen (the drawer docks, not covers).

const HTML = `
<div id="host">
  <div class="term">
    <span class="src" data-find="f1">re-reads scrollback</span>
    <span class="src" data-find="f2">drops findings</span>
  </div>
  <div class="capture">
    <div class="finding" data-find="f1">Unbounded re-scan</div>
    <div class="finding" data-find="f2">Sub-floor dropped</div>
  </div>
</div>`;

const src = (id: string) => document.querySelector(`.term .src[data-find="${id}"]`)!;
const finding = (id: string) => document.querySelector(`.finding[data-find="${id}"]`)!;
const enter = (el: Element) => el.dispatchEvent(new MouseEvent('mouseenter'));
const leave = (el: Element) => el.dispatchEvent(new MouseEvent('mouseleave'));

describe('cross-highlight (§16.8 — terminal source ↔ capture finding)', () => {
  let host: HTMLElement;
  let ch: CrossHighlight;

  beforeEach(() => {
    document.body.innerHTML = HTML;
    host = document.getElementById('host')!;
    ch = wireCrossHighlight(host);
  });

  afterEach(() => ch?.dispose());

  it('hovering a finding lights both the finding and its terminal source', () => {
    enter(finding('f1'));
    expect(finding('f1').classList.contains('revealing')).toBe(true);
    expect(src('f1').classList.contains('lit')).toBe(true);
    expect(finding('f2').classList.contains('revealing')).toBe(false);
    expect(src('f2').classList.contains('lit')).toBe(false);
  });

  it('leaving the finding clears both ends', () => {
    enter(finding('f1'));
    leave(finding('f1'));
    expect(finding('f1').classList.contains('revealing')).toBe(false);
    expect(src('f1').classList.contains('lit')).toBe(false);
  });

  it('hovering a terminal source lights both ends too (symmetric)', () => {
    enter(src('f2'));
    expect(src('f2').classList.contains('lit')).toBe(true);
    expect(finding('f2').classList.contains('revealing')).toBe(true);
  });

  it('reveal() drives the pair programmatically (for deep-links / the future contract)', () => {
    ch.reveal('f1', true);
    expect(src('f1').classList.contains('lit')).toBe(true);
    expect(finding('f1').classList.contains('revealing')).toBe(true);
    ch.reveal('f1', false);
    expect(src('f1').classList.contains('lit')).toBe(false);
    expect(finding('f1').classList.contains('revealing')).toBe(false);
  });

  it('keeps both ends present in the DOM while lit (both visible at once)', () => {
    ch.reveal('f1', true);
    expect(document.querySelector('.term .src[data-find="f1"]')).not.toBeNull();
    expect(document.querySelector('.finding[data-find="f1"]')).not.toBeNull();
  });

  it('reveal() tolerates ids with selector-significant characters (no DOMException)', () => {
    const weird = 'f"]:x'; // quote + bracket + pseudo-class: breaks a raw `[data-find="${id}"]` selector
    document.body.innerHTML = `
      <div id="h2">
        <div class="term"><span class="src" data-find='${weird}'>s</span></div>
        <div class="capture"><div class="finding" data-find='${weird}'>f</div></div>
      </div>`;
    const h2 = document.getElementById('h2')!;
    const ch2 = wireCrossHighlight(h2);
    expect(() => ch2.reveal(weird, true)).not.toThrow();
    expect(h2.querySelector('.finding')!.classList.contains('revealing')).toBe(true);
    expect(h2.querySelector('.term .src')!.classList.contains('lit')).toBe(true);
    ch2.dispose();
  });

  it('after dispose, hovering no longer lights anything', () => {
    ch.dispose();
    enter(finding('f1'));
    expect(src('f1').classList.contains('lit')).toBe(false);
    expect(finding('f1').classList.contains('revealing')).toBe(false);
  });
});
