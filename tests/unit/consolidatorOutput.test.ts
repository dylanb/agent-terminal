import { describe, expect, it } from 'vitest';
import {
  CONSOLIDATOR_VERDICTS,
  consolidatorOutputProblems,
  consolidatorOutputWellFormed,
  exampleConsolidatorOutput,
  parseConsolidatorOutput,
  verdictCarriesReason,
  type ConsolidatorVerdict,
} from '../../src/shared/consolidatorOutput';

// §27.6 — the consolidator's output is JSON with one writer (the consolidator actor) and
// readers (the completion validator that gates the turn, the branch that reads the verdict + roster). One
// definition in the shared layer so the prompt composer, the completion gate, and the loop-state
// reader/provider cannot drift. It grades the CLOSED verdict set and the roster⊆catalog relationship — never
// the quality of the judgment.

const CATALOG = ['review-plan-principal', 'review-plan-security', 'review-plan-contracts'];
const out = (o: Record<string, unknown>): string => JSON.stringify(o);

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
  it.each([
    ['not JSON', 'verdict: clean\n', /not valid JSON/],
    ['not an object', '"clean"', /not a JSON object/],
    ['no verdict', out({ roster: CATALOG }), /verdict/],
    ['a verdict outside the closed set', out({ verdict: 'looks fine' }), /verdict/],
  ])('rejects output that is %s, and says so', (_what, text, problem) => {
    expect(consolidatorOutputWellFormed(text, CATALOG)).toBe(false);
    expect(consolidatorOutputProblems(text, CATALOG).join('\n')).toMatch(problem);
  });

  it('accepts a terminal verdict with NO roster (a terminal verdict needs none, AC3)', () => {
    expect(consolidatorOutputWellFormed(out({ verdict: 'clean' }), CATALOG)).toBe(true);
    expect(consolidatorOutputWellFormed(out({ verdict: 'stop for a human', reason: 'two reviewers disagree' }), CATALOG)).toBe(true);
  });

  it('a roster supplied on a terminal verdict is IGNORED, not malformed (AC3)', () => {
    expect(consolidatorOutputWellFormed(out({ verdict: 'clean', roster: ['not-a-real-persona'] }), CATALOG)).toBe(true);
  });

  it('reads output with a byte order mark', () => {
    expect(consolidatorOutputWellFormed(`\uFEFF${out({ verdict: 'clean' })}`, CATALOG)).toBe(true);
  });
});

describe('consolidatorOutputWellFormed — the roster⊆catalog relationship for `another round` (AC3/AC4)', () => {
  it('accepts `another round` with a subset roster drawn from the catalog', () => {
    expect(consolidatorOutputWellFormed(out({ verdict: 'another round', roster: ['review-plan-principal'] }), CATALOG)).toBe(true);
  });

  it('accepts `another round` with the whole catalog as the roster', () => {
    expect(consolidatorOutputWellFormed(out({ verdict: 'another round', roster: CATALOG }), CATALOG)).toBe(true);
  });

  it('rejects `another round` with an EMPTY or missing roster, or one that is not a list (a round must run someone, AC3)', () => {
    for (const roster of [[], undefined, 'review-plan-principal']) {
      expect(consolidatorOutputWellFormed(out({ verdict: 'another round', roster }), CATALOG)).toBe(false);
    }
  });

  it('rejects `another round` naming a persona the catalog does not declare (§27.4 — never invocable)', () => {
    expect(consolidatorOutputWellFormed(out({ verdict: 'another round', roster: ['review-plan-principal', 'ghost-persona'] }), CATALOG)).toBe(false);
  });
});

describe('parseConsolidatorOutput — the branch reads verdict + roster + reason', () => {
  it('parses a well-formed `another round` to its verdict and chosen roster', () => {
    const parsed = parseConsolidatorOutput(out({ verdict: 'another round', roster: ['review-plan-security', 'review-plan-contracts'] }));
    expect(parsed).toEqual({ verdict: 'another round', roster: ['review-plan-security', 'review-plan-contracts'], reason: null });
  });

  it('parses a `stop for a human` verdict with its reason, trimmed', () => {
    const parsed = parseConsolidatorOutput(out({ verdict: 'stop for a human', reason: ' the reviewers disagree on the API shape ' }));
    expect(parsed?.verdict).toBe('stop for a human');
    expect(parsed?.reason).toBe('the reviewers disagree on the API shape');
  });

  it('parses `clean` with an empty roster and no reason', () => {
    expect(parseConsolidatorOutput(out({ verdict: 'clean' }))).toEqual({ verdict: 'clean', roster: [], reason: null });
  });

  it('returns null when there is no verdict to read', () => {
    expect(parseConsolidatorOutput(out({ roster: ['review-plan-principal'] }))).toBeNull();
    expect(parseConsolidatorOutput('verdict: clean\n')).toBeNull();
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

// §27.6/§27.12 — the verdict checker names what is wrong, so a repair retry can fix exactly that.
describe('consolidatorOutputProblems — names each defect (§27.6/§27.12)', () => {
  it('reports nothing for each canonical example', () => {
    for (const v of CONSOLIDATOR_VERDICTS) expect(consolidatorOutputProblems(exampleConsolidatorOutput(v, CATALOG), CATALOG)).toEqual([]);
  });

  it('names a missing verdict and quotes the allowed values', () => {
    const problems = consolidatorOutputProblems(out({ verdict: 'probably fine' }), CATALOG).join('\n');
    for (const v of CONSOLIDATOR_VERDICTS) expect(problems).toContain(v);
  });

  it('names an `another round` with no roster, and a roster entry outside the catalog by position, listing the catalog', () => {
    expect(consolidatorOutputProblems(out({ verdict: 'another round' }), CATALOG).join('\n')).toContain('roster');
    const problems = consolidatorOutputProblems(out({ verdict: 'another round', roster: ['review-plan-principal', 'review-plan-ghost'] }), CATALOG).join('\n');
    expect(problems).toContain('"roster"[1]');
    for (const p of CATALOG) expect(problems).toContain(p);
  });

  it('never repeats text from the output', () => {
    const problems = consolidatorOutputProblems(out({ verdict: '<script>x</script>' }), CATALOG)
      .concat(consolidatorOutputProblems(out({ verdict: 'another round', roster: ['<script>y</script>'] }), CATALOG))
      .join('\n');
    expect(problems).not.toContain('script');
  });

  it('agrees with consolidatorOutputWellFormed', () => {
    for (const t of ['', out({ verdict: 'clean' }), out({ verdict: 'another round' }), out({ verdict: 'another round', roster: ['review-plan-ghost'] })]) {
      expect(consolidatorOutputWellFormed(t, CATALOG)).toBe(consolidatorOutputProblems(t, CATALOG).length === 0);
    }
  });
});
