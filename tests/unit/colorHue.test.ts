import { describe, expect, it } from 'vitest';
import { hslHue, hueDistance } from '../helpers/colorHue';

describe('hslHue', () => {
  it('reads the HSL hue of a parsed colour in degrees', () => {
    expect(hslHue([255, 0, 0, 1])).toBeCloseTo(0);
    expect(hslHue([0, 255, 0, 1])).toBeCloseTo(120);
    expect(hslHue([0, 0, 255, 1])).toBeCloseTo(240);
    expect(hslHue([255, 0, 128, 1])).toBeCloseTo(329.88, 1);
    expect(hslHue([0xc9, 0x7f, 0x14, 1])).toBeCloseTo(35.47, 1);
  });

  it('ignores alpha, so a tint is graded on its own colour before compositing', () => {
    expect(hslHue([242, 165, 60, 0.15])).toBeCloseTo(hslHue([242, 165, 60, 1]));
  });

  it('has no hue for a grey, so a grey can never pass a hue check', () => {
    expect(hslHue([94, 107, 107, 1])).not.toBeNaN();
    expect(hslHue([128, 128, 128, 1])).toBeNaN();
    expect(hueDistance(hslHue([128, 128, 128, 1]), 0) <= 15).toBe(false);
  });
});

describe('hueDistance', () => {
  it('measures the shorter way round the colour circle', () => {
    expect(hueDistance(10, 40)).toBe(30);
    expect(hueDistance(350, 5)).toBe(15);
    expect(hueDistance(5, 350)).toBe(15);
    expect(hueDistance(0, 180)).toBe(180);
  });
});
