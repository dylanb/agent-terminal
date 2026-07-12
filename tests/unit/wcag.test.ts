import { describe, it, expect } from 'vitest';
import { parseColor, contrastRatio } from '../helpers/wcag';

// The channel UNITS differ between the two serializations Chromium emits, and reading one as the other is
// silent: `color(srgb 0.97 0.92 0.92)` read as 0–255 is near-black, which turns a failing contrast ratio
// into a passing one. Every colour here is a real Chromium computed value (see the styleContrast probes).

describe('parseColor', () => {
  it('reads rgb()/rgba() channels as 0–255 and a missing alpha as opaque', () => {
    expect(parseColor('rgb(1, 2, 3)')).toEqual([1, 2, 3, 1]);
    expect(parseColor('rgba(1, 2, 3, 0.5)')).toEqual([1, 2, 3, 0.5]);
  });

  // How Chromium serializes `color-mix(in srgb, …)` — the idiom this stylesheet uses for every tinted wash.
  it('reads color(srgb …) channels as 0–1, scaled to the same 0–255 space as rgb()', () => {
    const [r, g, b, a] = parseColor('color(srgb 0.975294 0.916471 0.918431)');
    expect([Math.round(r), Math.round(g), Math.round(b)]).toEqual([249, 234, 234]); // the painted pixel
    expect(a).toBe(1);
  });

  it('reads the slash-alpha of color(srgb … / a)', () => {
    expect(parseColor('color(srgb 1 0 0 / 0.5)')).toEqual([255, 0, 0, 0.5]);
  });

  it('THROWS on a serialization it does not understand rather than guessing channels', () => {
    // Guessing is what makes the defect silent: a pin that mis-parses still returns a number, and the
    // number passes. A wide-gamut or perceptual colour space is not sRGB and this arithmetic is not valid
    // for it — the test must go red, not green.
    expect(() => parseColor('color(display-p3 0.9 0.2 0.2)')).toThrow();
    expect(() => parseColor('oklch(0.7 0.1 20)')).toThrow();
    expect(() => parseColor('not-a-colour')).toThrow();
  });

  it('grades the same painted colour identically through either serialization', () => {
    const fg = parseColor('rgb(192, 42, 47)');
    expect(contrastRatio(fg, parseColor('color(srgb 0.975294 0.916471 0.918431)'))).toBeCloseTo(
      contrastRatio(fg, parseColor('rgb(249, 234, 234)')),
      1,
    );
  });
});
