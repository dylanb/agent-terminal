// The WCAG 2.1 colour arithmetic, once. A browser tells the tests what it PAINTED (CLAUDE.md: never
// re-derive a painted value by parsing CSS); this turns those painted values into the ratios the success
// criteria are stated in.
//
// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance

export type RGBA = [number, number, number, number];

/** A computed colour string (`rgb(…)` / `rgba(…)`) as channels; a missing alpha reads as opaque. */
export function parseColor(computed: string): RGBA {
  const n = computed.match(/[\d.]+/g);
  if (!n) throw new Error(`unparseable computed colour: ${computed}`);
  return [Number(n[0]), Number(n[1]), Number(n[2]), n[3] === undefined ? 1 : Number(n[3])];
}

/** `fg` composited over `bg` at fg's alpha — what the compositor actually shows. */
export function compositeOver(fg: RGBA, bg: RGBA): RGBA {
  return [
    fg[0] * fg[3] + bg[0] * (1 - fg[3]),
    fg[1] * fg[3] + bg[1] * (1 - fg[3]),
    fg[2] * fg[3] + bg[2] * (1 - fg[3]),
    1,
  ];
}

const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

export function relativeLuminance(c: RGBA): number {
  return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
}

export function contrastRatio(a: RGBA, b: RGBA): number {
  const [hi, lo] = [relativeLuminance(a) + 0.05, relativeLuminance(b) + 0.05].sort((x, y) => y - x);
  return hi / lo;
}
