import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// WCAG 1.4.3 pinning test for the small status-text tokens (§24.2.3 rail/panel/modal). The locked
// "Galley · Lit" mood keeps bright accent hues, so dedicated `--*-text` tokens carry the accessible
// foreground that clears 4.5:1 (memory wcag-overrides-locked-mood).

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

// When the loop panel is open, every spill tone must clear 4.5:1 on its ACTUAL background: the spill
// wash over the `.loopstat[aria-expanded="true"]` background over the card. If the read-out stacks its
// OWN wash under the spill's, the text sits on a failing doubled wash — so this composites the real
// backgrounds to discriminate that doubling (WCAG 1.4.3).
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

/** Resolve a CSS background expression to an RGBA. Handles `var(--x)`, the `color-mix(in srgb,
 *  var(--x) N%, transparent)` form the spills use, a bare color, and transparent/absent (alpha 0). */
function resolveBg(map: Record<string, string>, expr: string | null): RGBA {
  if (!expr || expr === 'transparent') return [0, 0, 0, 0];
  const mix = expr.match(/color-mix\(\s*in srgb\s*,\s*var\(\s*(--[\w-]+)\s*\)\s*([\d.]+)%\s*,\s*transparent\s*\)/);
  if (mix) return [...(parseColor(resolve(map, mix[1])).slice(0, 3) as [number, number, number]), parseFloat(mix[2]) / 100];
  const ref = expr.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  return parseColor(ref ? resolve(map, ref[1]) : expr);
}
/** The `background:` value of a CSS rule, or null when the rule or its background is absent. */
function ruleBackground(escapedSelector: string): string | null {
  const m = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!m) return null;
  const b = m[1].match(/(?:^|;)\s*background\s*:\s*([^;]+);/);
  return b ? b[1].trim() : null;
}

// The attn-bar dismiss focus ring is a non-text indicator that must clear 3:1 on the bar's tinted wash,
// not the plain card (WCAG 2.1 SC 1.4.11). The global `button:focus-visible` `--signal` outline clears
// 3:1 only on `--card` and falls short on the tinted bar in light theme, so the bar scopes its own ring.
function blockBody(re: RegExp): string | null {
  const m = css.match(re);
  return m ? m[1] : null;
}
function outlineColor(body: string): string | null {
  const oc = body.match(/(?:^|;)\s*outline-color\s*:\s*([^;]+);/);
  if (oc) return oc[1].trim();
  const sh = body.match(/(?:^|;)\s*outline\s*:\s*([^;]+);/);
  const c = sh ? sh[1].match(/var\(\s*--[\w-]+\s*\)|#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)/) : null;
  return c ? c[0] : null;
}
/** The outline color that actually paints on the attn-bar dismiss button: a scoped
 *  `.attn-bar …:focus-visible` rule wins over the global `button:focus-visible` outline. */
function attnFocusOutline(): string {
  const scoped = blockBody(/\.attn-bar (?:button|\.x):focus-visible\s*\{([^}]*)\}/);
  if (scoped) {
    const c = outlineColor(scoped);
    if (c) return c;
  }
  const global = blockBody(/button:focus-visible,\s*a:focus-visible[^{]*\{([^}]*)\}/);
  if (!global) throw new Error('global focus-visible rule not found');
  const c = outlineColor(global);
  if (!c) throw new Error('global focus-visible rule has no outline color');
  return c;
}
/** Resolve `color-mix(in srgb, var(--a) N%, var(--b))` of two opaque tokens to a hex string. */
function resolveOpaqueMix(map: Record<string, string>, expr: string): string {
  const mix = expr.match(
    /color-mix\(\s*in srgb\s*,\s*var\(\s*(--[\w-]+)\s*\)\s*([\d.]+)%\s*,\s*var\(\s*(--[\w-]+)\s*\)\s*\)/,
  );
  if (!mix) throw new Error(`not an opaque color-mix: ${expr}`);
  const a = parseColor(resolve(map, mix[1]));
  const b = parseColor(resolve(map, mix[3]));
  const p = parseFloat(mix[2]) / 100;
  return toHex([a[0] * p + b[0] * (1 - p), a[1] * p + b[1] * (1 - p), a[2] * p + b[2] * (1 - p), 1]);
}

describe('attn-bar dismiss focus ring contrast (WCAG 2.1 SC 1.4.11)', () => {
  const barBgExpr = ruleBackground('\\.attn-bar');
  if (!barBgExpr) throw new Error('.attn-bar background not found');
  const outline = attnFocusOutline();
  for (const [themeName, map] of [['light', light], ['dark', dark]] as const) {
    it(`${themeName}: dismiss focus ring clears 3:1 on the attn-bar background`, () => {
      const ref = outline.match(/^var\(\s*(--[\w-]+)\s*\)$/);
      const ringHex = ref ? resolve(map, ref[1]) : outline;
      expect(contrast(ringHex, resolveOpaqueMix(map, barBgExpr))).toBeGreaterThanOrEqual(3);
    });
  }
});

describe('expanded loop read-out contrast (WCAG 1.4.3 AA)', () => {
  const readoutBgExpr = ruleBackground('\\.flowstrip \\.loopstat\\[aria-expanded="true"\\]');
  for (const [themeName, map] of [['light', light], ['dark', dark]] as const) {
    const card = parseColor(resolve(map, '--card'));
    const underSpill = over(resolveBg(map, readoutBgExpr), card);
    for (const tone of ['await', 'work', 'settle'] as const) {
      const token = tone === 'await' ? '--attn-text' : tone === 'work' ? '--signal-text' : '--pass-text';
      it(`${themeName}: .spill.${tone} text clears 4.5:1 when the read-out is expanded (panel open)`, () => {
        const spillBg = over(resolveBg(map, ruleBackground(`\\.spill\\.${tone}`)), underSpill);
        expect(contrast(resolve(map, token), toHex(spillBg))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
