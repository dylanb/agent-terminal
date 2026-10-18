import { describe, expect, it } from 'vitest';
import { normaliseText, statesText, unqualifiedOccurrences } from '../helpers/statesText';

const SHARED = ['1. **Behavioral Equivalence:** It produces identical runtime output,', '   side effects, and control flow.'];

describe('statesText — the same words in the same order, ignoring line breaks, indentation and Markdown emphasis', () => {
  it('matches a re-wrapped, re-indented, re-emphasised copy inside a larger document', () => {
    const doc = 'Preamble.\n\n1. *Behavioral   Equivalence:* It produces\n     identical _runtime_ output, side\neffects, and __control flow__.\n\nAfter.';
    expect(statesText(doc, SHARED)).toBe(true);
  });

  it('accepts the shared text as one string or as lines', () => {
    const doc = SHARED.join('\n');
    expect(statesText(doc, SHARED)).toBe(true);
    expect(statesText(doc, SHARED.join(' '))).toBe(true);
  });

  it('rejects a copy with one word changed, dropped or reordered', () => {
    const base = '1. Behavioral Equivalence: It produces identical runtime output, side effects, and control flow.';
    expect(statesText(base.replace('identical', 'similar'), SHARED)).toBe(false);
    expect(statesText(base.replace('runtime ', ''), SHARED)).toBe(false);
    expect(statesText(base.replace('side effects, and control flow', 'control flow, and side effects'), SHARED)).toBe(false);
  });

  it('keeps an identifier underscore, so snake_case is not read as emphasis', () => {
    expect(normaliseText('set work_goal and _this_')).toBe('set work_goal and this');
    expect(statesText('the work goal', 'work_goal')).toBe(false);
  });

  it('throws on a shared text that normalises to nothing, which every document would otherwise state', () => {
    expect(() => statesText('any document', '')).toThrow(/empty/);
    expect(() => statesText('any document', [])).toThrow(/empty/);
    expect(() => statesText('any document', ['**', '  '])).toThrow(/empty/);
  });

  it('is case-sensitive: the shared text is quoted, not paraphrased', () => {
    expect(statesText('1. behavioral equivalence: it produces identical runtime output, side effects, and control flow.', SHARED)).toBe(false);
  });
});

describe('unqualifiedOccurrences — a phrase not followed by its qualifier', () => {
  const phrase = 'no findings';
  const qualifier = 'other than NITs';

  it('returns nothing when every occurrence carries the qualifier, across line breaks and emphasis', () => {
    expect(unqualifiedOccurrences('stop when a pass returned no\nfindings **other than NITs**.', phrase, qualifier)).toEqual([]);
  });

  it('allows a separating comma or dash between the phrase and the qualifier', () => {
    expect(unqualifiedOccurrences('nothing left to fix, or only documentation fixes', 'nothing left to fix', 'or only documentation fixes')).toEqual([]);
    expect(unqualifiedOccurrences('nothing left to fix — or only documentation fixes', 'nothing left to fix', 'or only documentation fixes')).toEqual([]);
  });

  it('does not let a semicolon join the qualifier to the phrase, since it ends the clause', () => {
    expect(unqualifiedOccurrences('returned no findings; other than NITs, the pass is done', phrase, qualifier)).toHaveLength(1);
  });

  it('throws on a phrase or qualifier that normalises to nothing', () => {
    expect(() => unqualifiedOccurrences('no findings', '', qualifier)).toThrow(/empty/);
    expect(() => unqualifiedOccurrences('no findings', phrase, '**')).toThrow(/empty/);
  });

  it('names each unqualified occurrence, matched case-insensitively, with its context', () => {
    const doc = 'No findings means done. Later: returned no findings other than NITs. Finally no findings.';
    const hits = unqualifiedOccurrences(doc, phrase, qualifier);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toContain('No findings means done');
    expect(hits[1]).toContain('Finally no findings');
  });

  it('does not count a qualifier that appears later in the sentence but not right after the phrase', () => {
    expect(unqualifiedOccurrences('returned no findings and nothing other than NITs', phrase, qualifier)).toHaveLength(1);
  });
});
