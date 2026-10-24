// https://www.w3.org/TR/css-color-4/#hsl-to-rgb
import type { RGBA } from './wcag';

/** HSL hue in degrees, [0, 360). NaN for an achromatic colour, which has no hue. */
export function hslHue([r, g, b]: RGBA): number {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return NaN;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** min(|a−b|, 360°−|a−b|) */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}
