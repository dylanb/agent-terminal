import { describe, expect, it } from 'vitest';
import { findingSignature, nextImpasse } from '../../src/main/findingSignature';

// §26.8 — the consolidated finding SIGNATURE is the stuck detector's input: SHA256 of the top-3 kept
// findings sorted by (severity desc, message). Two identical signatures in a row flags the run stuck.
describe('finding signature (§26.8)', () => {
  const order = ['minor', 'major', 'blocker']; // ascending; desc rank blocker > major > minor

  it('is stable for the same kept findings regardless of input order', () => {
    const a = [
      { severity: 'minor', message: 'b' },
      { severity: 'blocker', message: 'a' },
    ];
    const b = [
      { severity: 'blocker', message: 'a' },
      { severity: 'minor', message: 'b' },
    ];
    expect(findingSignature(a, order)).toBe(findingSignature(b, order));
  });

  it('differs when a finding message changes', () => {
    const a = [{ severity: 'major', message: 'x' }];
    const b = [{ severity: 'major', message: 'y' }];
    expect(findingSignature(a, order)).not.toBe(findingSignature(b, order));
  });

  it('is the empty string for an empty kept set (an empty signature never matches, §26.8)', () => {
    expect(findingSignature([], order)).toBe('');
  });

  it('considers only the top-3 (a change in a 4th-ranked finding does not move it)', () => {
    const top3 = [
      { severity: 'blocker', message: 'a' },
      { severity: 'blocker', message: 'b' },
      { severity: 'major', message: 'c' },
    ];
    const withFourth = [...top3, { severity: 'minor', message: 'd' }];
    const withDifferentFourth = [...top3, { severity: 'minor', message: 'ZZZ' }];
    expect(findingSignature(withFourth, order)).toBe(findingSignature(withDifferentFourth, order));
    expect(findingSignature(top3, order)).toBe(findingSignature(withFourth, order));
  });
});

// §26.8 — the pure stuck tracker: a new signature identical to the last increments the run of identical
// signatures; two in a row (>=2) flags stuck. An empty signature resets and never flags.
describe('impasse tracking (§26.8)', () => {
  it('counts a first non-empty signature as one occurrence, not stuck', () => {
    expect(nextImpasse('', 0, 'sigA')).toEqual({ lastFindingsSig: 'sigA', consecutiveIdentical: 1, stuck: false });
  });

  it('flags stuck when the same signature repeats (two in a row)', () => {
    expect(nextImpasse('sigA', 1, 'sigA')).toEqual({ lastFindingsSig: 'sigA', consecutiveIdentical: 2, stuck: true });
  });

  it('resets the run when the signature changes', () => {
    expect(nextImpasse('sigA', 2, 'sigB')).toEqual({ lastFindingsSig: 'sigB', consecutiveIdentical: 1, stuck: false });
  });

  it('an empty signature resets and never flags stuck (§26.8)', () => {
    expect(nextImpasse('sigA', 1, '')).toEqual({ lastFindingsSig: '', consecutiveIdentical: 0, stuck: false });
  });
});
