import { describe, expect, it } from 'vitest';
import { sameText, sentenceStates, statesText, timesStated, unqualifiedOccurrences } from '../helpers/statesText';

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
    expect(sameText('set work_goal and _this_', 'set work_goal and this')).toBe(true);
    expect(statesText('the work goal', 'work_goal')).toBe(false);
  });

  it('matches regardless of case only when asked to', () => {
    expect(statesText('The Materiality\nFloor', 'materiality floor')).toBe(false);
    expect(statesText('The Materiality\nFloor', 'materiality floor', { ignoreCase: true })).toBe(true);
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

describe('timesStated — how many times a document states a shared text', () => {
  it('counts each copy, however it is wrapped or emphasised', () => {
    expect(timesStated('A *rule* here.\nThen a\n  rule here again.', 'rule here')).toBe(2);
  });

  it('counts none when the text is absent, and ignores case only when asked to', () => {
    expect(timesStated('nothing to see', 'rule here')).toBe(0);
    expect(timesStated('Rule here. rule here.', 'rule here', { ignoreCase: true })).toBe(2);
  });
});

describe('sameText — two texts are the same words in the same order', () => {
  it('ignores line breaks, indentation and emphasis', () => {
    expect(sameText(SHARED.join('\n'), '1. Behavioral Equivalence: It produces identical runtime output, side effects, and control flow.')).toBe(true);
  });

  it('is false when one text only contains the other', () => {
    expect(sameText(`Preamble. ${SHARED.join(' ')}`, SHARED)).toBe(false);
  });
});

describe('sentenceStates with ignoreCase', () => {
  it('finds needles in one sentence regardless of case only when asked to', () => {
    expect(sentenceStates('Log it in the Review History.', ['review history'])).toBe(false);
    expect(sentenceStates('Log it in the Review History.', ['review history'], { ignoreCase: true })).toBe(true);
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

describe('sentenceStates — every needle inside one sentence', () => {
  it('matches needles in one sentence across line breaks and emphasis', () => {
    expect(sentenceStates('Record a NIT as\n**`dismissed — nit`** with a reason. Then stop.', ['NIT', '`dismissed — nit`', 'reason'])).toBe(true);
  });

  it('does not match needles split across two sentences', () => {
    expect(sentenceStates('Record a NIT. It is `dismissed — nit` with a reason.', ['NIT', '`dismissed — nit`'])).toBe(false);
  });

  it('is case-sensitive, so `NIT` is not found inside "unit"', () => {
    expect(sentenceStates('Run the unit tests.', ['NIT'])).toBe(false);
  });

  it('throws on no needles or a needle that normalises to nothing', () => {
    expect(() => sentenceStates('any sentence.', [])).toThrow(/needles/);
    expect(() => sentenceStates('any sentence.', ['**'])).toThrow(/empty/);
  });
});
