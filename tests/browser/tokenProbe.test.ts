import { afterEach, describe, expect, it } from 'vitest';
import { UNRESOLVED, paintColors, paintTokens, sameColor } from '../helpers/tokenProbe';
import { parseColor } from '../helpers/wcag';

afterEach(() => {
  document.documentElement.removeAttribute('style');
});

describe('paintTokens', () => {
  it('paints the unresolved sentinel for a token nothing defines', () => {
    const painted = paintTokens(['--never-defined']);
    expect(sameColor(parseColor(painted['--never-defined']), parseColor(UNRESOLVED))).toBe(true);
  });

  it('paints the colour a defined token resolves to, keyed by name', () => {
    document.documentElement.style.setProperty('--probe-a', 'rgba(0,152,219,.12)');
    document.documentElement.style.setProperty('--probe-b', '#C97F14');
    const painted = paintTokens(['--probe-a', '--probe-b']);
    const [a, b] = paintColors(['rgba(0,152,219,.12)', '#C97F14']);
    expect(sameColor(parseColor(painted['--probe-a']), parseColor(a))).toBe(true);
    expect(sameColor(parseColor(painted['--probe-b']), parseColor(b))).toBe(true);
    expect(sameColor(parseColor(painted['--probe-b']), parseColor(UNRESOLVED))).toBe(false);
  });

  it('paints the sentinel for an alias whose target is undefined', () => {
    document.documentElement.style.setProperty('--probe-alias', 'var(--never-defined)');
    const painted = paintTokens(['--probe-alias']);
    expect(sameColor(parseColor(painted['--probe-alias']), parseColor(UNRESOLVED))).toBe(true);
  });

  it('leaves the document as it found it', () => {
    const before = document.body.innerHTML;
    paintTokens(['--never-defined']);
    paintColors(['#000000']);
    expect(document.body.innerHTML).toBe(before);
  });
});

describe('sameColor', () => {
  it('accepts one 8-bit step of rounding and nothing more', () => {
    expect(sameColor([10, 20, 30, 1], [11, 19, 30, 1])).toBe(true);
    expect(sameColor([10, 20, 30, 1], [12, 20, 30, 1])).toBe(false);
    expect(sameColor([10, 20, 30, 0.12], [10, 20, 30, 0.12 + 1 / 255])).toBe(true);
    expect(sameColor([10, 20, 30, 0.12], [10, 20, 30, 0.2])).toBe(false);
  });
});
