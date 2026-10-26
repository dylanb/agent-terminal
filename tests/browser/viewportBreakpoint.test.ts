import { describe, expect, it } from 'vitest';

const RENDERER_CSS = import.meta.glob<string>('../../src/renderer/**/*.css', { eager: true, query: '?inline', import: 'default' });

function widthConditions(css: string): string[] {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const found: string[] = [];
  const walk = (rules: CSSRuleList): void => {
    for (const rule of rules) {
      if (rule instanceof CSSMediaRule || rule instanceof CSSContainerRule) {
        if (/(?<![\w-])(?:(?:min|max)-)?(?:device-)?(?:width|inline-size)\b/.test(rule.conditionText)) found.push(rule.conditionText);
      }
      if (rule instanceof CSSGroupingRule || rule instanceof CSSStyleRule) walk(rule.cssRules);
    }
  };
  walk(sheet.cssRules);
  return found;
}

describe('the viewport-width check', () => {
  it.each([
    '@media (max-width: 639px) { .a { display: block } }',
    '@media screen and (min-width: 40rem) { .a { display: block } }',
    '@media (width < 640px) { .a { display: block } }',
    '@container (max-inline-size: 639px) { .a { display: block } }',
    '@supports (display: grid) { @media (max-width: 639px) { .a { display: block } } }',
    '.a { color: inherit; @media (max-width: 639px) { display: block } }',
  ])('flags %s', css => {
    expect(widthConditions(css)).toHaveLength(1);
  });

  it.each([
    '@media (prefers-reduced-motion: reduce) { .a { animation: none } }',
    '@media print { .a { display: none } }',
    '.a { max-width: 92vw; min-width: 0 }',
    '/* @media (max-width: 639px) */ .a { color: inherit }',
  ])('accepts %s', css => {
    expect(widthConditions(css)).toEqual([]);
  });
});

it('no renderer stylesheet defines a viewport or container width breakpoint', () => {
  expect(Object.keys(RENDERER_CSS).length).toBeGreaterThan(0);
  const offending = Object.entries(RENDERER_CSS).flatMap(([file, css]) => widthConditions(css).map(condition => `${file}: ${condition}`));
  expect(offending).toEqual([]);
});
