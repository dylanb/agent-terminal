import { afterEach, describe, expect, it } from 'vitest';
import { offTable, paintColors, readColors, readLengths, sameColor } from '../helpers/tokenProbe';
import { parseColor } from '../helpers/wcag';

const html = document.documentElement;

afterEach(() => {
  html.removeAttribute('style');
});

describe('readColors', () => {
  it('reads a token nothing defines as null', () => {
    expect(readColors(['--never-defined'])).toEqual({ '--never-defined': null });
  });

  it('reads the colour a defined token paints, keyed by name', () => {
    html.style.setProperty('--probe-a', 'rgba(0,152,219,.12)');
    html.style.setProperty('--probe-b', '#C97F14');
    const colors = readColors(['--probe-a', '--probe-b']);
    const [a, b] = paintColors(['rgba(0,152,219,.12)', '#C97F14']);
    expect(sameColor(colors['--probe-a']!, parseColor(a))).toBe(true);
    expect(sameColor(colors['--probe-b']!, parseColor(b))).toBe(true);
  });

  it('reads an alias whose target is undefined as null', () => {
    html.style.setProperty('--probe-alias', 'var(--never-defined)');
    expect(readColors(['--probe-alias'])).toEqual({ '--probe-alias': null });
  });

  it('leaves the document as it found it', () => {
    const before = document.body.innerHTML;
    readColors(['--never-defined']);
    readLengths(['--never-defined']);
    paintColors(['#000000']);
    expect(document.body.innerHTML).toBe(before);
  });
});

describe('readLengths', () => {
  it('reads a defined token as its computed length and an undefined one as null', () => {
    html.style.setProperty('--probe-len', '7px');
    expect(readLengths(['--probe-len', '--never-defined'])).toEqual({ '--probe-len': '7px', '--never-defined': null });
  });
});

describe('offTable', () => {
  it('names each token that does not paint its table value, and only those', () => {
    html.style.setProperty('--card', '#FFFFFF');
    html.style.setProperty('--signal', '#123456');
    expect(offTable(['--card', '--signal'], 'light')).toEqual(['--signal painted rgb(18, 52, 86), expected rgb(0, 152, 219)']);
  });

  it('names a token nothing defines', () => {
    expect(offTable(['--card'], 'light')).toHaveLength(1);
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
