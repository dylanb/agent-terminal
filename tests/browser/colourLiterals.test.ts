import { describe, expect, it } from 'vitest';

const RENDERER_CSS = import.meta.glob<string>('../../src/renderer/**/*.css', { eager: true, query: '?inline', import: 'default' });
const TOKENS = '../../src/renderer/src/tokens.css';

const ALLOWED = [
  'src/renderer/src/styles.css .seg .seg-opt.on { box-shadow: rgba(8, 16, 28, 0.13) 0px 1px 2px }',
  'src/renderer/src/styles.css [data-theme="dark"] .kr-chord .kc { background: rgb(27, 37, 48) }',
  'src/renderer/src/styles.css .pill.send { color: rgb(255, 255, 255) }',
  'src/renderer/src/styles.css .pill.app { color: rgb(255, 255, 255) }',
  'src/renderer/src/styles.css .tree .f .tag-pr { color: var(--act,#c0392b) }',
  'src/renderer/src/styles.css .tree .f .tag-pr { border: 1px solid var(--act,#c0392b) }',
  'src/renderer/src/styles.css .flow-scrim { background: rgba(8, 12, 18, 0.42) }',
  'src/renderer/src/styles.css .flow-modal .card { box-shadow: rgba(8, 16, 28, 0.34) 0px 30px 80px }',
];

const NOT_A_COLOUR = new Set(['transparent', 'currentcolor', 'inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const NAMES_PROPERTIES = new Set(['transition', 'transition-property', 'will-change']);

function paintsColour(value: string): boolean {
  const text = value.replace(/url\([^)]*\)|"[^"]*"|'[^']*'/g, ' ');
  if (/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i.test(text)) return true;
  return (text.match(/(?<![\w-])[a-z][a-z-]*\b(?!\()/gi) ?? [])
    .some(word => !NOT_A_COLOUR.has(word.toLowerCase()) && CSS.supports('color', word));
}

function colourLiterals(css: string): string[] {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const found = new Set<string>();
  const walk = (rules: CSSRuleList): void => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        for (const declaration of rule.style.cssText.split(/;\s*/)) {
          const property = declaration.slice(0, declaration.indexOf(':')).trim();
          const value = declaration.slice(declaration.indexOf(':') + 1);
          if (declaration && !NAMES_PROPERTIES.has(property) && paintsColour(value)) found.add(`${rule.selectorText} { ${declaration} }`);
        }
      }
      if (rule instanceof CSSGroupingRule || rule instanceof CSSStyleRule) walk(rule.cssRules);
    }
  };
  walk(sheet.cssRules);
  return [...found];
}

describe('the colour-literal check', () => {
  it.each([
    '.a { color: #c0ffee }',
    '.a { background: rgb(1 2 3) }',
    '.a { border: 1px solid hsl(10 20% 30%) }',
    '.a { box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.5) }',
    '.a { outline-color: oklch(70% 0.1 200) }',
    '.a { color: rebeccapurple }',
    '.a { --local: white }',
    '@media print { .a { color: black } }',
    '.a { background: color-mix(in srgb, var(--surface) 50%, red) }',
  ])('flags %s', css => {
    expect(colourLiterals(css)).toHaveLength(1);
  });

  it.each([
    '.a { color: var(--text) }',
    '.a { background: color-mix(in srgb, var(--surface) 50%, transparent) }',
    '.a { border: 1px solid currentcolor }',
    '.a { color: inherit; border-style: solid; font-family: "IBM Plex Sans", system-ui, sans-serif }',
    '.a { background-image: url("red.png") }',
    '.a { transition: opacity 0.12s, background 0.12s; will-change: background }',
    '/* color: red */ .a { color: var(--text) }',
  ])('accepts %s', css => {
    expect(colourLiterals(css)).toEqual([]);
  });
});

it('no renderer stylesheet outside tokens.css paints a colour of its own, apart from the listed existing ones', () => {
  const sheets = Object.entries(RENDERER_CSS).filter(([file]) => file !== TOKENS);
  expect({
    tokensFound: TOKENS in RENDERER_CSS,
    sheets: sheets.length > 0,
    literals: sheets.flatMap(([file, css]) => colourLiterals(css).map(found => `${file.replace('../../', '')} ${found}`)),
  }).toEqual({ tokensFound: true, sheets: true, literals: ALLOWED });
});
