import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { CM_THEME_STYLES } from '../../src/renderer/src/viewerRender';

// WCAG 1.4.3 (UI-STANDARDS theme-via-tokens): real functional surfaces must clear 4.5:1 in BOTH
// themes. This resolves the shipped tokens straight from styles.css and computes the actual ratio,
// so it survives a token rename and fails only on a genuine contrast regression.

const css = readFileSync('src/renderer/src/styles.css', 'utf8');

function tokenBlock(anchor: string): Map<string, string> {
  const start = css.indexOf(anchor);
  if (start === -1) throw new Error(`tokenBlock: anchor not found in styles.css: ${anchor}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  if (open === -1 || close === -1) throw new Error(`tokenBlock: no { } block after anchor: ${anchor}`);
  const map = new Map<string, string>();
  for (const m of css.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    map.set(m[1], m[2].trim());
  }
  return map;
}

const root = tokenBlock(':root');
const dark = tokenBlock('[data-theme="dark"]');
const themeTokens = (mode: 'light' | 'dark'): Map<string, string> =>
  mode === 'dark' ? new Map([...root, ...dark]) : root;

/** Resolve a CSS value's var() chains + fallbacks down to a concrete colour (#rrggbb or rgba(...)). */
function resolve(value: string, tokens: Map<string, string>): string {
  let v = value.trim();
  for (let i = 0; i < 10 && v.startsWith('var('); i++) {
    const inner = v.slice(4, v.lastIndexOf(')'));
    const comma = inner.indexOf(',');
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? '' : inner.slice(comma + 1).trim();
    v = (tokens.get(name) ?? fallback).trim();
  }
  return v;
}

function ruleDecl(selector: string, prop: string): string {
  const at = css.indexOf(selector + ' {');
  if (at === -1) throw new Error(`ruleDecl: selector not found in styles.css: ${selector}`);
  const end = css.indexOf('}', at);
  if (end === -1) throw new Error(`ruleDecl: unterminated rule block for ${selector}`);
  const block = css.slice(at, end);
  const m = block.match(new RegExp(`(?:^|[;{])\\s*${prop}\\s*:\\s*([^;]+);`));
  if (!m) throw new Error(`no ${prop} on ${selector}`);
  return m[1].trim();
}

/** Composite a possibly-translucent resolved colour over an opaque base hex → #rrggbb. */
function flatten(value: string, baseHex: string): string {
  const m = value.match(/rgba?\(([^)]+)\)/);
  if (!m) return value; // already an opaque hex
  const [r, g, b, a = '1'] = m[1].split(',').map((s) => parseFloat(s));
  const base = baseHex.replace('#', '');
  const mix = [0, 2, 4].map((i, k) => {
    const bc = parseInt(base.slice(i, i + 2), 16);
    return Math.round([r, g, b][k] * Number(a) + bc * (1 - Number(a)));
  });
  return '#' + mix.map((c) => c.toString(16).padStart(2, '0')).join('');
}

function relLum(hex: string): number {
  let h = hex.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join(''); // #fff → #ffffff
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a: string, b: string): number {
  const [la, lb] = [relLum(a), relLum(b)].sort((x, y) => y - x);
  return (la + 0.05) / (lb + 0.05);
}

describe('functional-surface contrast (WCAG 1.4.3)', () => {
  for (const mode of ['light', 'dark'] as const) {
    const t = themeTokens(mode);

    it(`the directory-changed notice clears 4.5:1 in ${mode}`, () => {
      const fg = resolve(ruleDecl('.swap-blocked', 'color'), t);
      const bg = resolve(ruleDecl('.swap-blocked', 'background'), t);
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
    });

    it(`the PR provenance tag clears 4.5:1 on the panel in ${mode}`, () => {
      const fg = resolve(ruleDecl('.tree .f .tag-pr', 'color'), t);
      expect(contrast(fg, resolve('var(--card)', t))).toBeGreaterThanOrEqual(4.5);
    });

    // Active-state surfaces: signal text on the translucent signal-wash, composited over the panel.
    const card = resolve('var(--card)', t);
    for (const [name, sel] of [
      ['active nav item', '.nav.on'],
      ['active status chip', '.status-chip.on'],
      ['selected file row', '.tree .f.sel'],
    ] as const) {
      it(`the ${name} clears 4.5:1 in ${mode}`, () => {
        const fg = resolve(ruleDecl(sel, 'color'), t);
        const bg = flatten(resolve(ruleDecl(sel, 'background'), t), card);
        expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }

    for (const [name, sel] of [
      ['send gate button', '.pill.send'],
      ['approve gate button', '.pill.app'],
    ] as const) {
      it(`the ${name} clears 4.5:1 in ${mode}`, () => {
        const fg = resolve(ruleDecl(sel, 'color'), t);
        const bg = resolve(ruleDecl(sel, 'background'), t);
        expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
      });
    }

    // Signal-coloured interactive/label TEXT on the panel — must use the deepened --signal-ink so
    // it clears 4.5:1 in light (raw --signal is ~3.2:1). Guards against the whack-a-mole regression.
    for (const [name, sel] of [
      ['signal pill', '.pill.signal'],
      ['link button', '.linkbtn'],
      ['active flow station name', '.flow .stn.active .nm'],
      ['changed-file tag', '.tree .f .tag-changed'],
      ['markdown link', '.vbody.md a'],
      ['selected drawer tab', '.dtab[aria-selected="true"]'],
      ['report-prose summary', '.finding.report-prose details > summary'],
      ['template toggle', '.todo-tmpl .tmpl-toggle[aria-expanded="true"]'],
      ['provenance from-label', '.mock-todos .todo .meta .from'],
      ['gate verdict (bad)', '.loop .lrow .lv.bad'],
    ] as const) {
      it(`the ${name} text clears 4.5:1 on the panel in ${mode}`, () => {
        const fg = resolve(ruleDecl(sel, 'color'), t);
        expect(contrast(fg, card)).toBeGreaterThanOrEqual(4.5);
      });
    }

    // The code viewer's editor background is transparent, so its text/gutter sit on the panel.
    // This is the real-contrast regression test for the dark-mode near-black-code blocker.
    it(`the code viewer text + gutter clear 4.5:1 on the panel in ${mode}`, () => {
      const textFg = resolve(CM_THEME_STYLES['&'].color, t);
      const gutterFg = resolve(CM_THEME_STYLES['.cm-gutters'].color, t);
      expect(contrast(textFg, card)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(gutterFg, card)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe('flow rail dashed connector orientation (§24.1)', () => {
  it('uses a vertical-direction dashed gradient for a future segment in the vertical rail', () => {
    // The rail renders vertically (.flow.vert); a 90deg (horizontal) gradient on a 2px-wide column
    // renders as a solid line, so the future connector must declare a vertical-direction gradient.
    const bg = ruleDecl('.flow.vert .seg.future', 'background');
    expect(bg).toContain('repeating-linear-gradient');
    expect(bg).toMatch(/\b(0deg|180deg|to (top|bottom))\b/);
    expect(bg).not.toContain('90deg');
  });
});
