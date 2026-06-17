import { describe, expect, it } from 'vitest';
import { pickRevealTarget } from '../../src/renderer/src/reveal';

// The cross-highlight terminal→capture matcher (§16.8). It runs over the LIVE marker
// positions (resolved by selection.ts from xterm markers, which track reflow), so a
// resize that moved a capture's rows is already reflected in the spans passed here.
describe('pickRevealTarget — most-specific capture covering a terminal row (§16.8)', () => {
  it('returns the id of the span covering the row', () => {
    expect(pickRevealTarget([{ id: 'r', start: 10, end: 14 }], 12)).toBe('r');
  });

  it('returns null when no span covers the row', () => {
    expect(pickRevealTarget([{ id: 'r', start: 10, end: 14 }], 99)).toBeNull();
  });

  it('prefers the most specific (smallest) span when spans nest', () => {
    const spans = [
      { id: 'report', start: 3, end: 7 },
      { id: 'finding', start: 5, end: 5 },
    ];
    expect(pickRevealTarget(spans, 5)).toBe('finding');
  });

  it('is inclusive of both span endpoints', () => {
    const spans = [{ id: 'r', start: 3, end: 7 }];
    expect(pickRevealTarget(spans, 3)).toBe('r');
    expect(pickRevealTarget(spans, 7)).toBe('r');
  });
});
