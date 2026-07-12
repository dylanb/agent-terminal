// The WCAG 2.1 colour arithmetic, once. A browser tells the tests what it PAINTED (CLAUDE.md: never
// re-derive a painted value by parsing CSS); this turns those painted values into the ratios the success
// criteria are stated in.
//
// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance

export type RGBA = [number, number, number, number];

const RGB = /^rgba?\(([^)]+)\)$/;
const SRGB = /^color\(srgb ([^)]+)\)$/;
const nums = (s: string): number[] => s.split(/[\s,/]+/).filter(Boolean).map(Number);

/** A computed colour string as 0–255 channels with a 0–1 alpha; a missing alpha reads as opaque. Chromium
 *  emits `rgb()`/`rgba()` (channels 0–255) for plain colours and `color(srgb r g b[ / a])` (channels 0–1)
 *  for a resolved `color-mix(in srgb, …)`. Any OTHER serialization throws: this arithmetic is defined on
 *  sRGB, and a parser that guesses channels off an unrecognized string returns a number that still passes.
 *  https://www.w3.org/TR/css-color-4/#serializing-color-values */
export function parseColor(computed: string): RGBA {
  const s = computed.trim();
  const legacy = RGB.exec(s);
  if (legacy) {
    const n = nums(legacy[1]);
    if (n.length < 3 || n.some(Number.isNaN)) throw new Error(`unparseable computed colour: ${computed}`);
    return [n[0], n[1], n[2], n[3] ?? 1];
  }
  const srgb = SRGB.exec(s);
  if (srgb) {
    const n = nums(srgb[1]);
    if (n.length < 3 || n.some(Number.isNaN)) throw new Error(`unparseable computed colour: ${computed}`);
    return [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1];
  }
  throw new Error(`computed colour is not an sRGB serialization this WCAG arithmetic is valid for: ${computed}`);
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

/** A focus ring's painted colour: its outline colour at ITS OWN alpha, scaled by any group `opacity` above
 *  it, composited over the surface behind the ring. The ring has TWO independent alpha sources and dropping
 *  either grades a washed-out ring as a solid one — which is how a control loses its visible focus indicator
 *  with every ring pin still green (WCAG 2.1 SC 1.4.11). */
export function ringOver(outlineColor: string, groupAlpha: number, behind: RGBA): RGBA {
  const [r, g, b, a] = parseColor(outlineColor);
  return compositeOver([r, g, b, a * groupAlpha], behind);
}
