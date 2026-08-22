import { describe, it, expect } from 'vitest';
import { PHASE_OUTCOMES } from '../../src/shared/phaseOutcome';
import {
  PHASE_RESULT_GRAMMAR,
  parsePhaseResult,
  phaseResultWellFormed,
  examplePhaseResult,
} from '../../src/shared/phaseResult';

// §28.5.5 — the result-file grammar: one writer (the RED recipe/prompt), one predicate (the engine), one
// canonical example. These tests pin the OBSERVABLE contract (what parsePhaseResult returns, what
// phaseResultWellFormed judges) — never the internal scan. The vocabulary is phaseOutcome's; the grammar is
// the structural twin of roundReport's (§28.5.5): minimal contract, exact-string outcome, layout-tolerant.

describe('phaseResult grammar (§28.5.2 / §28.5.5)', () => {
  // UT-RESULT-1 + UT-RESULT-2 — the ONE canonical example is well-formed against its OWN predicate, for every
  // outcome (the shared-semantics anchor: writer, predicate, few-shot cannot drift).
  it('the canonical example is well-formed and round-trips its outcome, for every PHASE_OUTCOMES value', () => {
    for (const outcome of PHASE_OUTCOMES) {
      const doc = examplePhaseResult(outcome);
      expect(phaseResultWellFormed(doc)).toBe(true);
      expect(parsePhaseResult(doc).outcome).toBe(outcome);
      expect(parsePhaseResult(doc).capturedOutput).not.toBeNull();
    }
  });

  const wellFormed = (outcome: string, captured = 'AssertionError: expected 2 to be 3'): string =>
    `# Phase result\n\n${PHASE_RESULT_GRAMMAR.outcomeLabel}: ${outcome}\n\n${PHASE_RESULT_GRAMMAR.capturedOutputHeading}\n\n${captured}\n`;

  // UT-RESULT-3 — the outcome VALUE is exact-string, trimmed, NEVER normalized (mirrors DISPOSITIONS).
  it('accepts an outcome from the closed set (surrounding whitespace trimmed) and rejects any other spelling', () => {
    expect(parsePhaseResult(wellFormed('failed-assertion')).outcome).toBe('failed-assertion');
    // trimmed:
    expect(parsePhaseResult(wellFormed('  passed  ')).outcome).toBe('passed');
    // never normalized:
    for (const bad of ['Passed', 'PASSED', 'failed_assertion', 'pass', 'failed-assertion-ish']) {
      expect(parsePhaseResult(wellFormed(bad)).outcome).toBeNull();
      expect(phaseResultWellFormed(wellFormed(bad))).toBe(false);
    }
  });

  // UT-RESULT-4 — the raw captured output is a REQUIRED element (AC3), like `what-changed` for a fixed issue.
  it('is not well-formed when the captured-output section is absent', () => {
    const noCaptured = `# Phase result\n\n${PHASE_RESULT_GRAMMAR.outcomeLabel}: failed-assertion\n`;
    expect(phaseResultWellFormed(noCaptured)).toBe(false);
    expect(parsePhaseResult(noCaptured).capturedOutput).toBeNull();
    // ...but the outcome is still recovered (parse is not all-or-nothing):
    expect(parsePhaseResult(noCaptured).outcome).toBe('failed-assertion');
  });

  // UT-RESULT-5 — a missing / blank outcome is not well-formed.
  it('is not well-formed when the outcome field is missing or blank', () => {
    const noOutcome = `# Phase result\n\n${PHASE_RESULT_GRAMMAR.capturedOutputHeading}\n\nsome output\n`;
    expect(phaseResultWellFormed(noOutcome)).toBe(false);
    expect(parsePhaseResult(noOutcome).outcome).toBeNull();
    expect(phaseResultWellFormed(wellFormed(''))).toBe(false);
    expect(phaseResultWellFormed(wellFormed('   '))).toBe(false);
  });

  // UT-RESULT-6 — layout tolerance (§28.5.5): tokens under a different-but-valid arrangement still validate;
  // an over-constrained template would diverge the fake-agent from the real recipe (mirrors roundReport). The
  // one minimal structural rule: the classification (`outcome:`) precedes its evidence (`## captured output`),
  // so the free-form raw output — which may itself contain a line that looks like the field — is never mistaken
  // for the classification.
  it('recognizes the tokens under a bullet and amid extra prose, and never reads the field out of the raw body', () => {
    for (const bullet of ['- ', '* ', '1. ']) {
      const bulleted = `# Phase result\n\n${bullet}${PHASE_RESULT_GRAMMAR.outcomeLabel}: passed\n\n${PHASE_RESULT_GRAMMAR.capturedOutputHeading}\n\nok\n`;
      expect(phaseResultWellFormed(bulleted)).toBe(true);
      expect(parsePhaseResult(bulleted).outcome).toBe('passed');
    }
    // the captured body is returned trimmed (not just present/absent):
    const paddedBody = `${PHASE_RESULT_GRAMMAR.outcomeLabel}: passed\n\n${PHASE_RESULT_GRAMMAR.capturedOutputHeading}\n\n\n  the raw run  \n\n`;
    expect(parsePhaseResult(paddedBody).capturedOutput).toBe('the raw run');

    const withProse = `# Phase result\n\nSome preamble the agent wrote.\n\n${PHASE_RESULT_GRAMMAR.outcomeLabel}: failed-assertion\n\nMore prose.\n\n${PHASE_RESULT_GRAMMAR.capturedOutputHeading}\n\nE   assert False\n`;
    expect(phaseResultWellFormed(withProse)).toBe(true);
    expect(parsePhaseResult(withProse).outcome).toBe('failed-assertion');

    // the real outcome is the one BEFORE the captured section; a look-alike line inside the raw output is
    // captured as evidence, never mistaken for the classification.
    const spoofInBody = `${PHASE_RESULT_GRAMMAR.outcomeLabel}: failed-assertion\n\n${PHASE_RESULT_GRAMMAR.capturedOutputHeading}\n\nFAIL some.test.ts\n${PHASE_RESULT_GRAMMAR.outcomeLabel}: passed\n`;
    expect(parsePhaseResult(spoofInBody).outcome).toBe('failed-assertion');
    expect(parsePhaseResult(spoofInBody).capturedOutput).toContain('passed'); // the look-alike stays in the raw body
  });

  // UT-RESULT-7 — linear-time parse on adversarial input (no catastrophic-backtrack RegExp; a plain char
  // scan), mirroring roundReport's CWE-1333/400 guarantee. A pathological large input must parse in bounded
  // time (here: it simply returns rather than hanging).
  it('parses a large adversarial input without catastrophic backtracking', () => {
    const pathological = `${'#'.repeat(50_000)}\n${':'.repeat(50_000)}\n${'- '.repeat(50_000)}\n`;
    const started = performance.now();
    const parsed = parsePhaseResult(pathological);
    expect(performance.now() - started).toBeLessThan(1_000); // a plain scan is well under this; a ReDoS would blow it
    expect(parsed.outcome).toBeNull(); // no valid outcome in the noise
  });

  // UT-RESULT-9 (§28.5.3 / S4) — the GREEN turn's result file carries a SECOND classification, `build:`, in the
  // same grammar. It is parsed like `outcome` (before the captured-output heading, exact-string, never
  // normalized) but is OPTIONAL at the grammar level: a RED file that carries no `build:` stays well-formed
  // (the grammar is phase-agnostic — the GREEN gate, not the grammar, requires `build: built`).
  const greenBody = (outcome: string, build: string, captured = '$ pnpm run build\n Build succeeded'): string =>
    `# Phase result\n\n${PHASE_RESULT_GRAMMAR.outcomeLabel}: ${outcome}\n${PHASE_RESULT_GRAMMAR.buildLabel}: ${build}\n\n${PHASE_RESULT_GRAMMAR.capturedOutputHeading}\n\n${captured}\n`;

  it('parses the build field of a GREEN-shaped result and leaves RED results unaffected', () => {
    const parsed = parsePhaseResult(greenBody('passed', 'built'));
    expect(parsed.outcome).toBe('passed');
    expect(parsed.build).toBe('built');
    expect(parsed.capturedOutput).not.toBeNull();

    // a RED-shaped file (no build line) → build is null, and it is STILL well-formed (phase-agnostic grammar):
    const redDoc = examplePhaseResult('failed-assertion');
    expect(parsePhaseResult(redDoc).build).toBeNull();
    expect(phaseResultWellFormed(redDoc)).toBe(true);
  });

  it('never normalizes the build value and never reads it out of the raw captured body', () => {
    for (const bad of ['Built', 'BUILT', 'build_failed', 'ok', '']) {
      expect(parsePhaseResult(greenBody('passed', bad)).build).toBeNull();
    }
    // a `build:` look-alike line INSIDE the captured output is evidence, never the classification:
    const spoof = `${PHASE_RESULT_GRAMMAR.outcomeLabel}: passed\n\n${PHASE_RESULT_GRAMMAR.capturedOutputHeading}\n\nsome log\n${PHASE_RESULT_GRAMMAR.buildLabel}: built\n`;
    expect(parsePhaseResult(spoof).build).toBeNull();
    expect(parsePhaseResult(spoof).capturedOutput).toContain('built'); // stays in the raw body
  });

  // UT-RESULT-10 (§28.5.5 / S4) — the ONE canonical example gains an optional build line: RED callers (no
  // opts) get the byte-for-byte pre-S4 output (no `build:`); GREEN callers get a well-formed `passed`+`built`
  // few-shot the predicate round-trips. One generator → the prompt few-shot and the fake-agent output cannot
  // drift from the predicate.
  it('emits a build line only when asked, keeping the RED example free of one', () => {
    // no opts → no build line (the RED few-shot/e2e must not shift):
    for (const outcome of PHASE_OUTCOMES) {
      expect(examplePhaseResult(outcome)).not.toContain('build');
    }
    // GREEN opts → a `build: built` line, BEFORE the captured-output heading, and well-formed + round-tripping:
    const green = examplePhaseResult('passed', { build: 'built' });
    const headingIdx = green.indexOf(PHASE_RESULT_GRAMMAR.capturedOutputHeading);
    const buildIdx = green.indexOf(`${PHASE_RESULT_GRAMMAR.buildLabel}: built`);
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeLessThan(headingIdx);
    expect(phaseResultWellFormed(green)).toBe(true);
    expect(parsePhaseResult(green)).toMatchObject({ outcome: 'passed', build: 'built' });
  });

  // UT-RESULT-8 — the captured-output HEADING recognition rule (trim-then-exact, like roundReport's isHeading),
  // and a whitespace-only body is NOT "present" (parallel to roundReport's reason==='' reject).
  it('pins the captured-output heading rule and rejects a whitespace-only body', () => {
    // wrong level / missing space / wrong case are NOT the captured-output heading:
    const noSpace = `${PHASE_RESULT_GRAMMAR.outcomeLabel}: passed\n\n##captured output\n\nok\n`;
    const wrongCase = `${PHASE_RESULT_GRAMMAR.outcomeLabel}: passed\n\n## Captured Output\n\nok\n`;
    expect(parsePhaseResult(noSpace).capturedOutput).toBeNull();
    expect(parsePhaseResult(wrongCase).capturedOutput).toBeNull();
    // surrounding whitespace on a correct heading is tolerated:
    const padded = `${PHASE_RESULT_GRAMMAR.outcomeLabel}: passed\n\n  ${PHASE_RESULT_GRAMMAR.capturedOutputHeading}  \n\nok\n`;
    expect(parsePhaseResult(padded).capturedOutput).not.toBeNull();
    // whitespace-only body → not present:
    const emptyBody = `${PHASE_RESULT_GRAMMAR.outcomeLabel}: passed\n\n${PHASE_RESULT_GRAMMAR.capturedOutputHeading}\n\n   \n`;
    expect(parsePhaseResult(emptyBody).capturedOutput).toBeNull();
    expect(phaseResultWellFormed(emptyBody)).toBe(false);
  });
});
