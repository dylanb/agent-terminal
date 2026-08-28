import { describe, it, expect } from 'vitest';
import { PHASE_OUTCOMES, REFACTOR_COMPLETING_OUTCOME } from '../../src/shared/phaseOutcome';
import { BUILD_OUTCOMES } from '../../src/shared/buildOutcome';
import {
  PHASE_RESULT_GRAMMAR,
  parsePhaseResult,
  phaseResultWellFormed,
  examplePhaseResult,
  composePhaseResultInstruction,
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

  // UT-RESULT-9 (§28.5.3 / S4) — the GREEN turn's result file carries a SECOND classification, `build:`, in the
  // same grammar. Parsed like `outcome` (before the captured-output heading, exact-string, never normalized,
  // FIRST-match-wins) but OPTIONAL at the grammar level: a RED file that carries no `build:` stays well-formed
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

  it('parses build and outcome independently of source order (build before outcome)', () => {
    const buildFirst = `${PHASE_RESULT_GRAMMAR.buildLabel}: built\n${PHASE_RESULT_GRAMMAR.outcomeLabel}: passed\n\n${PHASE_RESULT_GRAMMAR.capturedOutputHeading}\n\nok\n`;
    expect(parsePhaseResult(buildFirst)).toMatchObject({ outcome: 'passed', build: 'built' });
  });

  it('never normalizes the build value, tolerates a bullet, and never reads it out of the raw captured body', () => {
    for (const bad of ['Built', 'BUILT', 'build_failed', 'ok', '']) {
      expect(parsePhaseResult(greenBody('passed', bad)).build).toBeNull();
    }
    // layout-tolerant like `outcome`: recognized under a bullet and with surrounding whitespace (shared fieldValue):
    for (const bullet of ['- ', '* ', '1. ']) {
      const bulleted = `${PHASE_RESULT_GRAMMAR.outcomeLabel}: passed\n${bullet}${PHASE_RESULT_GRAMMAR.buildLabel}:   built  \n\n${PHASE_RESULT_GRAMMAR.capturedOutputHeading}\n\nok\n`;
      expect(parsePhaseResult(bulleted).build).toBe('built');
    }
    // a `build:` look-alike line INSIDE the captured output is evidence, never the classification:
    const spoof = `${PHASE_RESULT_GRAMMAR.outcomeLabel}: passed\n\n${PHASE_RESULT_GRAMMAR.capturedOutputHeading}\n\nsome log\n${PHASE_RESULT_GRAMMAR.buildLabel}: built\n`;
    expect(parsePhaseResult(spoof).build).toBeNull();
    expect(parsePhaseResult(spoof).capturedOutput).toContain('built'); // stays in the raw body
  });

  // UT-RESULT-10 (regression) — both fields are FIRST-match-wins: an invalid first `outcome:`/`build:` line is
  // terminal for that field (→ null), NEVER overridden by a later valid one. A later valid line silently winning
  // would turn a malformed result into an accepted one — the RED/GREEN gate reads `resultOutcome`, so this is
  // gate integrity, not cosmetics.
  it('keeps outcome and build first-match-wins — a later valid line never overrides an invalid earlier one', () => {
    const outcomeDup = `${PHASE_RESULT_GRAMMAR.outcomeLabel}: bogus\n${PHASE_RESULT_GRAMMAR.outcomeLabel}: passed\n\n${PHASE_RESULT_GRAMMAR.capturedOutputHeading}\n\nok\n`;
    expect(parsePhaseResult(outcomeDup).outcome).toBeNull();
    expect(phaseResultWellFormed(outcomeDup)).toBe(false);

    const buildDup = `${PHASE_RESULT_GRAMMAR.outcomeLabel}: passed\n${PHASE_RESULT_GRAMMAR.buildLabel}: bogus\n${PHASE_RESULT_GRAMMAR.buildLabel}: built\n\n${PHASE_RESULT_GRAMMAR.capturedOutputHeading}\n\nok\n`;
    expect(parsePhaseResult(buildDup).build).toBeNull();
    // outcome is still recovered (independent fields):
    expect(parsePhaseResult(buildDup).outcome).toBe('passed');
  });

  // UT-RESULT-11 (§28.5.5 / S4) — the ONE canonical example gains an optional build line: RED callers (no opts)
  // get the byte-for-byte pre-S4 output; GREEN callers get a well-formed `passed`+`built` few-shot the predicate
  // round-trips. One generator → prompt few-shot, predicate happy-path, fake-agent output cannot drift.
  it('emits a build line only when asked, keeping the RED example byte-for-byte unchanged', () => {
    // byte-for-byte pin of the RED (no-opts) shape — a stray line/reorder would fail this, not just `.not.toContain`:
    expect(examplePhaseResult('failed-assertion')).toBe(
      '# Phase result\n\noutcome: failed-assertion\n\n## captured output\n\n' +
        '$ pnpm test\n × src/adder.test.ts > adds two numbers\n   AssertionError: expected 2 to be 3\n   - Expected\n   + Received\n',
    );
    // an empty opts object changes nothing; no outcome's RED shape carries a build line:
    for (const outcome of PHASE_OUTCOMES) {
      expect(examplePhaseResult(outcome, {})).toBe(examplePhaseResult(outcome));
      expect(examplePhaseResult(outcome)).not.toContain('build');
    }
    // GREEN opts insert EXACTLY the `build: built` line right after `outcome:` and change nothing else:
    const red = examplePhaseResult('passed');
    const green = examplePhaseResult('passed', { build: 'built' });
    expect(green).toBe(red.replace('outcome: passed\n', 'outcome: passed\nbuild: built\n'));
    // …and the GREEN few-shot is well-formed + round-trips both classifications:
    expect(phaseResultWellFormed(green)).toBe(true);
    expect(parsePhaseResult(green)).toMatchObject({ outcome: 'passed', build: 'built' });
    expect(green.indexOf('build: built')).toBeLessThan(green.indexOf(PHASE_RESULT_GRAMMAR.capturedOutputHeading));
  });
});

// §28.5.5 / §28 §7d — the shared phase-result WRITER block. These pin the OBSERVABLE contract: the composed
// lines carry the result rel, the grammar tokens and vocabulary (from the shared descriptors), the canonical
// few-shot, and the caller's `closing` bar prose verbatim; the outcome-only shape omits the build classification.
describe('composePhaseResultInstruction (§28.5.5 — the shared writer block)', () => {
  const RESULT_REL = '.agent-terminal/loop/artifacts/phase-result.md';
  const CLOSE = ['This round is done only when the tests still pass.', 'Fix, then re-run and re-classify.'];

  const outcomeOnly = composePhaseResultInstruction({
    resultRel: RESULT_REL,
    completingOutcome: REFACTOR_COMPLETING_OUTCOME,
    closing: CLOSE,
  }).join('\n');

  it('names the result file and interpolates the grammar tokens + full outcome vocabulary from the descriptors', () => {
    expect(outcomeOnly).toContain(RESULT_REL);
    expect(outcomeOnly).toContain(PHASE_RESULT_GRAMMAR.outcomeLabel);
    expect(outcomeOnly).toContain(PHASE_RESULT_GRAMMAR.capturedOutputHeading);
    for (const outcome of PHASE_OUTCOMES) expect(outcomeOnly).toContain(outcome);
  });

  it('opens by instructing the agent to run the tests and classify the run (the shared opening line)', () => {
    // Guards the shared opening line so a change to the writer's run→classify directive can't silently regress
    // (the RED/GREEN branches route through this — normalizing their intros to one phrasing was deliberate).
    expect(outcomeOnly).toContain('Run the test command for this change and classify');
  });

  it('embeds the ONE canonical example for the completing outcome (single-source with the gate predicate)', () => {
    const example = examplePhaseResult(REFACTOR_COMPLETING_OUTCOME);
    expect(phaseResultWellFormed(example)).toBe(true);
    expect(outcomeOnly).toContain(example.trimEnd());
  });

  it('threads the phase-specific closing prose verbatim (each caller supplies its own bar)', () => {
    for (const line of CLOSE) expect(outcomeOnly).toContain(line);
  });

  it('omits the build classification when no build is asked (softer than GREEN — no build: line)', () => {
    expect(outcomeOnly).not.toContain(`${PHASE_RESULT_GRAMMAR.buildLabel}:`);
    for (const b of BUILD_OUTCOMES) expect(outcomeOnly).not.toContain(b);
    // the few-shot for an outcome-only block carries no build line either
    expect(outcomeOnly).not.toContain('build: built');
  });

  it('includes the build classification + a build few-shot when a completing build outcome is given (GREEN)', () => {
    const withBuild = composePhaseResultInstruction({
      resultRel: RESULT_REL,
      completingOutcome: 'passed',
      build: { completingBuildOutcome: 'built' },
      closing: ['This turn is a valid GREEN only when the build succeeds.'],
    }).join('\n');
    expect(withBuild).toContain(PHASE_RESULT_GRAMMAR.buildLabel);
    for (const b of BUILD_OUTCOMES) expect(withBuild).toContain(b);
    expect(withBuild).toContain(examplePhaseResult('passed', { build: 'built' }).trimEnd());
  });
});
