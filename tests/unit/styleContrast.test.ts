import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// WCAG 1.4.3 pinning test for the small status-text tokens (§24.2.3 rail/panel/modal). The locked
// "Galley · Lit" mood keeps bright accent hues for borders/dots/washes, but small text on them must
// clear 4.5:1 — so dedicated `--*-text` tokens carry the accessible foreground. This reads the real
// styles.css, resolves the token cascade per theme, and asserts the ratio (memory wcag-overrides-locked-mood).

const css = readFileSync(path.join(__dirname, '../../src/renderer/src/styles.css'), 'utf8');

function parseBlock(selector: string): Record<string, string> {
  const m = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`block ${selector} not found`);
  const out: Record<string, string> = {};
  for (const decl of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[decl[1]] = decl[2].trim();
  return out;
}

const light = parseBlock(':root');
const dark = { ...light, ...parseBlock('\\[data-theme="dark"\\]') }; // dark cascades over light

function resolve(map: Record<string, string>, name: string): string {
  const v = map[name];
  if (!v) throw new Error(`token ${name} is undefined`);
  const ref = v.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  return ref ? resolve(map, ref[1]) : v;
}

const lin = (c: number): number => ((c /= 255), c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(fg: string, bg: string): number {
  const a = luminance(fg) + 0.05;
  const b = luminance(bg) + 0.05;
  return Math.max(a, b) / Math.min(a, b);
}

describe('status-text token contrast (WCAG 1.4.3 AA)', () => {
  for (const [themeName, map] of [['light', light], ['dark', dark]] as const) {
    for (const tone of ['signal', 'pass', 'attn'] as const) {
      it(`${themeName}: --${tone}-text clears 4.5:1 on --card`, () => {
        const ratio = contrast(resolve(map, `--${tone}-text`), resolve(map, '--card'));
        expect(ratio).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

// The modal's primary "Confirm & bootstrap" button is `.pill.signal` on the modal card (--card). Its
// foreground must clear 4.5:1 too — the raw bright `--signal` accent does not in the light theme, so
// the rule must resolve the accessible `--signal-text` token (memory wcag-overrides-locked-mood).
function ruleColor(escapedSelector: string): string {
  const m = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`rule ${escapedSelector} not found`);
  const c = m[1].match(/(?:^|;)\s*color\s*:\s*([^;]+);/);
  if (!c) throw new Error(`rule ${escapedSelector} has no color`);
  return c[1].trim();
}

describe('control text contrast (WCAG 1.4.3 AA)', () => {
  for (const [themeName, map] of [['light', light], ['dark', dark]] as const) {
    it(`${themeName}: .pill.signal text clears 4.5:1 on --card (modal Confirm button)`, () => {
      const color = ruleColor('\\.pill\\.signal');
      const ref = color.match(/^var\(\s*(--[\w-]+)\s*\)$/);
      const fg = ref ? resolve(map, ref[1]) : color;
      expect(contrast(fg, resolve(map, '--card'))).toBeGreaterThanOrEqual(4.5);
    });
  }
});

// When the loop panel is open, `.loopstat[aria-expanded="true"]` paints `--signal-wash` and the
// `.spill.work` pill inside paints `--signal-wash` again — so the working-status text sits on TWO
// stacked translucent washes over the card, not on the bare card the test above checks. Alpha-
// composite both layers and assert the work-tone text still clears 4.5:1 on that real background.
type RGBA = [number, number, number, number];
function parseColor(v: string): RGBA {
  const rgba = v.match(/rgba?\(([^)]+)\)/);
  if (rgba) {
    const p = rgba[1].split(',').map((s) => parseFloat(s.trim()));
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  const h = v.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
}
const over = (fg: RGBA, bg: RGBA): RGBA =>
  [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1];
const toHex = (c: RGBA): string => '#' + c.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');

describe('expanded loop read-out contrast (WCAG 1.4.3 AA)', () => {
  for (const [themeName, map] of [['light', light], ['dark', dark]] as const) {
    it(`${themeName}: .spill.work text clears 4.5:1 over the doubled --signal-wash (panel open)`, () => {
      const card = parseColor(resolve(map, '--card'));
      const wash = parseColor(resolve(map, '--signal-wash'));
      const bg = over(wash, over(wash, card)); // spill wash over loopstat wash over card
      expect(contrast(resolve(map, '--signal-text'), toHex(bg))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
