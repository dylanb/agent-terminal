import { describe, expect, it } from 'vitest';
import {
  CONSOLIDATOR_VERDICTS,
  consolidatorOutputWellFormed,
  exampleConsolidatorOutput,
  parseConsolidatorOutput,
  verdictCarriesReason,
  type ConsolidatorVerdict,
} from '../../src/shared/consolidatorOutput';

// §27.6 — the consolidator's output is a serialized vocabulary with one writer (the consolidator actor) and
// readers (the completion validator that gates the turn, the branch that reads the verdict + roster). One
// definition in the shared layer so the prompt composer, the completion gate, and the loop-state
// reader/provider cannot drift. It grades the CLOSED verdict set and the roster⊆catalog relationship — never
// the quality of the judgment.

const CATALOG = ['review-plan-principal', 'review-plan-security', 'review-plan-contracts'];

describe('the verdict set is spec-fixed (§27.6)', () => {
  it('is exactly the three-value closed set', () => {
    expect(CONSOLIDATOR_VERDICTS).toEqual(['clean', 'another round', 'stop for a human']);
  });
});

describe('consolidatorOutputWellFormed — the canonical example anchors every verdict (§93)', () => {
  for (const verdict of CONSOLIDATOR_VERDICTS) {
    it(`accepts the generated canonical example for verdict "${verdict}"`, () => {
      expect(consolidatorOutputWellFormed(exampleConsolidatorOutput(verdict, CATALOG), CATALOG)).toBe(true);
    });
  }
});

describe('consolidatorOutputWellFormed — verdict membership (AC3)', () => {
  it('rejects output missing a verdict entirely', () => {
    expect(consolidatorOutputWellFormed('# nothing here\n\njust prose\n', CATALOG)).toBe(false);
  });

  it('rejects a verdict outside the closed set', () => {
    expect(consolidatorOutputWellFormed('verdict: looks fine\n', CATALOG)).toBe(false);
  });

  it('accepts a terminal verdict with NO roster (a terminal verdict needs none, AC3)', () => {
    expect(consolidatorOutputWellFormed('verdict: clean\n', CATALOG)).toBe(true);
    expect(consolidatorOutputWellFormed('verdict: stop for a human\nreason: two reviewers disagree\n', CATALOG)).toBe(true);
  });

  it('a roster supplied on a terminal verdict is IGNORED, not malformed (AC3)', () => {
    expect(consolidatorOutputWellFormed('verdict: clean\nroster: not-a-real-persona\n', CATALOG)).toBe(true);
  });
});

describe('consolidatorOutputWellFormed — the roster⊆catalog relationship for `another round` (AC3/AC4)', () => {
  it('accepts `another round` with a subset roster drawn from the catalog', () => {
    expect(consolidatorOutputWellFormed('verdict: another round\nroster: review-plan-principal\n', CATALOG)).toBe(true);
  });

  it('accepts `another round` with the whole catalog as the roster', () => {
    expect(consolidatorOutputWellFormed(`verdict: another round\nroster: ${CATALOG.join(', ')}\n`, CATALOG)).toBe(true);
  });

  it('rejects `another round` with an EMPTY roster (a round must run someone, AC3)', () => {
    expect(consolidatorOutputWellFormed('verdict: another round\nroster:\n', CATALOG)).toBe(false);
    expect(consolidatorOutputWellFormed('verdict: another round\n', CATALOG)).toBe(false);
  });

  it('rejects `another round` naming a persona the catalog does not declare (§27.4 — never invocable)', () => {
    expect(consolidatorOutputWellFormed('verdict: another round\nroster: review-plan-principal, ghost-persona\n', CATALOG)).toBe(false);
  });
});

describe('parseConsolidatorOutput — the branch reads verdict + roster + reason', () => {
  it('parses a well-formed `another round` to its verdict and chosen roster', () => {
    const parsed = parseConsolidatorOutput('verdict: another round\nroster: review-plan-security, review-plan-contracts\n');
    expect(parsed).toEqual({ verdict: 'another round', roster: ['review-plan-security', 'review-plan-contracts'], reason: null });
  });

  it('parses a `stop for a human` verdict with its reason', () => {
    const parsed = parseConsolidatorOutput('verdict: stop for a human\nreason: the reviewers disagree on the API shape\n');
    expect(parsed?.verdict).toBe('stop for a human');
    expect(parsed?.reason).toBe('the reviewers disagree on the API shape');
  });

  it('parses `clean` with an empty roster and no reason', () => {
    expect(parseConsolidatorOutput('verdict: clean\n')).toEqual({ verdict: 'clean', roster: [], reason: null });
  });

  it('returns null when there is no verdict to read', () => {
    expect(parseConsolidatorOutput('roster: review-plan-principal\n')).toBeNull();
  });
});

describe('verdictCarriesReason — the persisted verdict/reason gate (reason iff stop-for-a-human)', () => {
  it('is true only for `stop for a human`, mirroring the error_reason writer↔reader gate', () => {
    const carries: Record<ConsolidatorVerdict, boolean> = {
      clean: false,
      'another round': false,
      'stop for a human': true,
    };
    for (const v of CONSOLIDATOR_VERDICTS) expect(verdictCarriesReason(v)).toBe(carries[v]);
  });
});
