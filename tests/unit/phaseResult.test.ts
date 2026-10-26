import { describe, it, expect } from 'vitest';
import { PHASE_OUTCOMES, REFACTOR_COMPLETING_OUTCOME } from '../../src/shared/phaseOutcome';
import { BUILD_OUTCOMES } from '../../src/shared/buildOutcome';
import {
  PHASE_RESULT_FIELDS,
  RED_COMPLETION,
  composePhaseResultInstruction,
  exampleCapturedOutput,
  examplePhaseResult,
  phaseOutputRel,
  phaseResultEnd,
  readPhaseResult,
} from '../../src/shared/phaseResult';

// §28.5.5 — the phase result is JSON the engine judges (the outcome, GREEN's build, RED's intended
// failures), and the raw test run is kept verbatim in a file of its own beside it, which the engine requires to
// be present and non-empty but never parses.

const RESULT_REL = '.agent-terminal/loop/artifacts/red-result.json';
const result = (o: Record<string, unknown>): string => JSON.stringify(o);
const end = (text: string, want: Parameters<typeof phaseResultEnd>[1], captured: string | null = 'AssertionError: expected 2 to be 3') =>
  phaseResultEnd({ result: text, captured, capturedRel: phaseOutputRel(RESULT_REL) }, want);

describe('reading a phase result (§28.5.2 / §28.5.5)', () => {
  it('reads the canonical example back as itself, for every outcome', () => {
    for (const outcome of PHASE_OUTCOMES) {
      expect(readPhaseResult(examplePhaseResult(outcome))).toEqual({ ok: true, result: { outcome, build: null, intendedFailures: null, verificationOnly: false } });
    }
  });

  it('reads the build and the intended failures when the example carries them', () => {
    expect(readPhaseResult(examplePhaseResult('passed', { build: 'built' }))).toMatchObject({ ok: true, result: { build: 'built' } });
    const red = readPhaseResult(examplePhaseResult('failed-assertion', { intendedFailures: [{ file: 'tests/adder.test.ts', line: 5 }] }));
    expect(red).toMatchObject({ ok: true, result: { intendedFailures: [{ file: 'tests/adder.test.ts', line: 5 }] } });
  });

  it('reads a file with a byte order mark, and ignores fields it does not know', () => {
    expect(readPhaseResult(`﻿${result({ outcome: 'passed', notes: 'x' })}`)).toMatchObject({ ok: true, result: { outcome: 'passed' } });
  });

  it.each([
    ['not JSON', 'outcome: passed\n\n## captured output\n\nok\n', /not valid JSON/],
    ['not an object', '["passed"]', /not a JSON object/],
    ['no outcome', result({ build: 'built' }), /"outcome"/],
    ['an outcome outside the closed set', result({ outcome: 'Passed' }), /"outcome"/],
    ['a build outside the closed set', result({ outcome: 'passed', build: 'ok' }), /"build"/],
    ['intended failures that are not a list', result({ outcome: 'failed-assertion', intendedFailures: 'tests/a.ts:5' }), /"intendedFailures"/],
    ['an intended failure with no line', result({ outcome: 'failed-assertion', intendedFailures: [{ file: 'tests/a.ts' }] }), /"intendedFailures"/],
    ['an intended failure with a line that is not a positive whole number', result({ outcome: 'failed-assertion', intendedFailures: [{ file: 'tests/a.ts', line: 0 }] }), /"intendedFailures"/],
    ['an intended failure whose file has a control character', result({ outcome: 'failed-assertion', intendedFailures: [{ file: 'tests/a\n.ts', line: 5 }] }), /"intendedFailures"/],
  ])('is not well-formed with %s, and says what is wrong', (_what, text, problem) => {
    const read = readPhaseResult(text);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problem).toMatch(problem);
  });

  it('lists the allowed outcomes when the outcome is wrong', () => {
    const read = readPhaseResult(result({ outcome: 'flaky' }));
    if (read.ok) throw new Error('expected a problem');
    for (const o of PHASE_OUTCOMES) expect(read.problem).toContain(o);
  });

  it('never repeats text from the file in what it says is wrong', () => {
    for (const text of [result({ outcome: '<script>' }), result({ outcome: 'passed', build: '<script>' }), '{"outcome": "<script>'])
      expect(JSON.stringify(readPhaseResult(text))).not.toContain('script');
  });
});

describe('whether a phase result completes the turn (§28.5.3)', () => {
  it('completes when the outcome is the one wanted and the captured run is there', () => {
    expect(end(examplePhaseResult('failed-assertion'), { outcome: 'failed-assertion' }).ok).toBe(true);
    expect(end(examplePhaseResult('passed', { build: 'built' }), { outcome: 'passed', build: 'built' }).ok).toBe(true);
  });

  it.each([
    ['another outcome', examplePhaseResult('errored'), { outcome: 'failed-assertion' as const }, /reports errored, not failed-assertion/],
    ['no build where one is wanted', examplePhaseResult('passed'), { outcome: 'passed' as const, build: 'built' as const }, /reports no build, not built/],
    ['another build', examplePhaseResult('passed', { build: 'build-failed' }), { outcome: 'passed' as const, build: 'built' as const }, /reports build build-failed, not built/],
    ['a file that is not JSON', 'outcome: passed', { outcome: 'passed' as const }, /not valid JSON/],
  ])('does not complete with %s, and says why', (_what, text, want, why) => {
    const e = end(text, want);
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.problem).toMatch(why);
  });

  it('does not complete when the captured run is missing or empty, naming its file', () => {
    for (const captured of [null, '', '  \n ']) {
      const e = end(examplePhaseResult('passed'), { outcome: 'passed' }, captured);
      expect(e.ok).toBe(false);
      if (!e.ok) expect(e.problem).toContain(phaseOutputRel(RESULT_REL));
    }
  });

  it('never reads the captured run: any text in it is evidence, not a classification', () => {
    expect(end(examplePhaseResult('passed'), { outcome: 'passed' }, '{"outcome": "errored"}\n## captured output\noutcome: errored').ok).toBe(true);
  });
});

describe('the captured run lives beside the result', () => {
  it.each([
    ['.agent-terminal/loop/artifacts/red-result.json', '.agent-terminal/loop/artifacts/red-result.output.txt'],
    ['.agent-terminal/loop/artifacts/red-result.slice-2.json', '.agent-terminal/loop/artifacts/red-result.slice-2.output.txt'],
    ['.agent-terminal/loop/refactor-results/3.json', '.agent-terminal/loop/refactor-results/3.output.txt'],
    ['red-result.json', 'red-result.output.txt'],
  ])('%s keeps its run in %s', (rel, out) => {
    expect(phaseOutputRel(rel)).toBe(out);
  });

  it('every outcome has a plausible captured run to show', () => {
    for (const o of PHASE_OUTCOMES) expect(exampleCapturedOutput(o).trim().length).toBeGreaterThan(0);
  });
});

describe('composePhaseResultInstruction (§28.5.5 — the shared writer block)', () => {
  const lines = (build?: boolean): string =>
    composePhaseResultInstruction({
      resultRel: RESULT_REL,
      completingOutcome: build ? 'passed' : 'failed-assertion',
      ...(build ? { build: { completingBuildOutcome: 'built' as const } } : {}),
      closing: ['CLOSING LINE'],
    }).join('\n');

  it('names the result file, the captured-run file, every JSON field it asks for, and the full outcome vocabulary', () => {
    const p = lines();
    expect(p).toContain(RESULT_REL);
    expect(p).toContain(phaseOutputRel(RESULT_REL));
    expect(p).toContain(`"${PHASE_RESULT_FIELDS.outcome}"`);
    for (const o of PHASE_OUTCOMES) expect(p).toContain(o);
  });

  it('tells the agent to save the raw run verbatim in its own file', () => {
    expect(lines()).toMatch(/raw[\s\S]*verbatim[\s\S]*output\.txt/i);
  });

  it('embeds the canonical example for the completing outcome, well-formed against the predicate', () => {
    const p = lines();
    const json = p.slice(p.indexOf('{'), p.lastIndexOf('}') + 1);
    expect(readPhaseResult(json)).toMatchObject({ ok: true, result: { outcome: 'failed-assertion' } });
  });

  it('threads the phase-specific closing prose verbatim (each caller supplies its own bar)', () => {
    expect(lines().endsWith('CLOSING LINE')).toBe(true);
  });

  it('asks for the build only when a completing build outcome is given (GREEN)', () => {
    expect(lines()).not.toContain(`"${PHASE_RESULT_FIELDS.build}"`);
    const p = lines(true);
    expect(p).toContain(`"${PHASE_RESULT_FIELDS.build}"`);
    for (const b of BUILD_OUTCOMES) expect(p).toContain(b);
    const json = p.slice(p.indexOf('{'), p.lastIndexOf('}') + 1);
    expect(readPhaseResult(json)).toMatchObject({ ok: true, result: { outcome: 'passed', build: 'built' } });
  });

  it('works for the refactor bar (tests still pass, no build)', () => {
    const p = composePhaseResultInstruction({ resultRel: RESULT_REL, completingOutcome: REFACTOR_COMPLETING_OUTCOME, closing: [] }).join('\n');
    expect(p).toContain(`"${PHASE_RESULT_FIELDS.outcome}": "${REFACTOR_COMPLETING_OUTCOME}"`);
  });
});

describe('a verification-only RED result (§28.5.3)', () => {
  const verifies = examplePhaseResult('passed', { verificationOnly: true });

  it('reads back as a passed run that verifies existing behavior', () => {
    expect(readPhaseResult(verifies)).toMatchObject({ ok: true, result: { outcome: 'passed', verificationOnly: true } });
    expect(readPhaseResult(examplePhaseResult('failed-assertion'))).toMatchObject({ ok: true, result: { verificationOnly: false } });
  });

  it.each([
    ['a verification claim on a run that did not pass', result({ outcome: 'failed-assertion', verificationOnly: true })],
    ['a verification claim that also declares intended failures', result({ outcome: 'passed', verificationOnly: true, intendedFailures: [{ file: 'tests/a.ts', line: 5 }] })],
    ['a verification claim that is not true or false', result({ outcome: 'passed', verificationOnly: 'yes' })],
  ])('is not well-formed with %s', (_what, text) => {
    const read = readPhaseResult(text);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.problem).toContain(`"${PHASE_RESULT_FIELDS.verificationOnly}"`);
  });

  it('completes RED, alongside a run that fails by assertion', () => {
    expect(end(verifies, RED_COMPLETION, 'Test Files  1 passed (1)').ok).toBe(true);
    expect(end(examplePhaseResult('failed-assertion'), RED_COMPLETION).ok).toBe(true);
  });

  it('does not complete RED with a passing run that does not claim verification', () => {
    const e = end(examplePhaseResult('passed'), RED_COMPLETION, 'Test Files  1 passed (1)');
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.problem).toMatch(/reports passed, not failed-assertion/);
  });

  it('does not complete GREEN or refactor: verification completes only RED', () => {
    const green = end(examplePhaseResult('passed', { build: 'built', verificationOnly: true }), { outcome: 'passed', build: 'built' });
    expect(green.ok).toBe(false);
    if (!green.ok) expect(green.problem).toContain('RED');
    expect(end(verifies, { outcome: REFACTOR_COMPLETING_OUTCOME }).ok).toBe(false);
  });
});
