import { describe, expect, it } from 'vitest';
import { DECISION_FILE_MAX_BYTES, DECISION_NOTE_MAX, parseDecisionFile, stepRuns, type BranchStep } from '../../src/shared/flowBranch';

const d: BranchStep = { id: 'd', decides: ['a', 'b'] };
const x: BranchStep = { id: 'x', when: { step: 'd', value: 'a' } };
const y: BranchStep = { id: 'y', when: { step: 'd', value: 'b' } };
const z: BranchStep = { id: 'z' };

describe('stepRuns', () => {
  it('a step with no when runs', () => {
    expect(stepRuns([{ id: 'only' }], {})).toEqual(['runs']);
  });

  it('steps waiting on an undecided step are unresolved', () => {
    expect(stepRuns([d, x, y, z], {})).toEqual(['runs', 'unresolved', 'unresolved', 'runs']);
  });

  it('a decision runs its matching steps and skips the others', () => {
    expect(stepRuns([d, x, y, z], { d: { value: 'b' } })).toEqual(['runs', 'skipped', 'runs', 'runs']);
  });

  it('a step that waits on a skipped deciding step is skipped', () => {
    const e: BranchStep = { id: 'e', when: { step: 'd', value: 'a' }, decides: ['p', 'q'] };
    const f: BranchStep = { id: 'f', when: { step: 'e', value: 'p' } };
    expect(stepRuns([d, e, f], { d: { value: 'b' } })).toEqual(['runs', 'skipped', 'skipped']);
  });
});

describe('parseDecisionFile', () => {
  it('reads a declared value', () => {
    expect(parseDecisionFile('{"decision":"b"}', ['a', 'b'])).toEqual({ ok: true, decision: { value: 'b' } });
  });

  it('keeps the note beside the value', () => {
    expect(parseDecisionFile('{"decision":"b","note":"feature request"}', ['a', 'b'])).toEqual({
      ok: true,
      decision: { value: 'b', note: 'feature request' },
    });
  });

  it('never reads a value out of a file that is not JSON, names no decision or names an undeclared value', () => {
    expect(parseDecisionFile('decision: b', ['a', 'b'])).toEqual({ ok: false, problem: 'not-json' });
    expect(parseDecisionFile('{"value":"b"}', ['a', 'b'])).toEqual({ ok: false, problem: 'no-decision-field' });
    expect(parseDecisionFile('{"decision":"c"}', ['a', 'b'])).toEqual({ ok: false, problem: 'undeclared-value' });
    expect(parseDecisionFile('{}', ['a', 'b'])).toEqual({ ok: false, problem: 'no-decision-field' });
    expect(parseDecisionFile('{"decision":3}', ['a', 'b'])).toEqual({ ok: false, problem: 'no-decision-field' });
    for (const root of ['null', '"b"', '3', 'true']) {
      expect(parseDecisionFile(root, ['a', 'b']), root).toEqual({ ok: false, problem: 'no-decision-field' });
    }
  });

  it('rejects a value that differs only by case or whitespace', () => {
    expect(parseDecisionFile('{"decision":"B"}', ['a', 'b'])).toEqual({ ok: false, problem: 'undeclared-value' });
    expect(parseDecisionFile('{"decision":" b"}', ['a', 'b'])).toEqual({ ok: false, problem: 'undeclared-value' });
  });

  it('strips control characters from the note and refuses an over-long note', () => {
    const parsed = parseDecisionFile(JSON.stringify({ decision: 'b', note: 'needs\u001b[31m triage\u0007' }), ['a', 'b']);
    expect(parsed.ok).toBe(true);
    const note = parsed.ok ? (parsed.decision.note ?? '') : '';
    expect(note).toBe('needs triage');
    expect(parseDecisionFile(JSON.stringify({ decision: 'b', note: `${'x'.repeat(DECISION_NOTE_MAX)}\u0007` }), ['a', 'b'])).toEqual({
      ok: true,
      decision: { value: 'b', note: 'x'.repeat(DECISION_NOTE_MAX) },
    });
    expect(parseDecisionFile(JSON.stringify({ decision: 'b', note: 'x'.repeat(DECISION_NOTE_MAX + 1) }), ['a', 'b'])).toEqual({ ok: false, problem: 'note-too-long' });
  });

  it('removes a control or invisible character inside the note before the length check, leaving no gap', () => {
    const half = 'x'.repeat(DECISION_NOTE_MAX / 2);
    expect(parseDecisionFile(JSON.stringify({ decision: 'b', note: `${half}\u0007${half}` }), ['a', 'b'])).toEqual({ ok: true, decision: { value: 'b', note: `${half}${half}` } });
    expect(parseDecisionFile(JSON.stringify({ decision: 'b', note: 'fea\u200Bture\u0000 request' }), ['a', 'b'])).toEqual({ ok: true, decision: { value: 'b', note: 'feature request' } });
  });

  it('removes invisible formatting characters and lone surrogates from the note, keeping the visible text', () => {
    const note = (raw: string): string | undefined => {
      const parsed = parseDecisionFile(JSON.stringify({ decision: 'b', note: raw }), ['a', 'b']);
      return parsed.ok ? parsed.decision.note : undefined;
    };
    const softHyphen = String.fromCodePoint(0xad);
    const tagA = String.fromCodePoint(0xe0041);
    const loneSurrogate = String.fromCharCode(0xd800);
    expect(note(`fea${softHyphen}ture`)).toBe('feature');
    expect(note(`not${tagA} a bug`)).toBe('not a bug');
    expect(note(`not a${loneSurrogate} bug`)).toBe('not a bug');
    expect(parseDecisionFile('{"decision":"b","note":"not a\\ud800 bug"}', ['a', 'b'])).toEqual({ ok: true, decision: { value: 'b', note: 'not a bug' } });
    expect(note('caf\u00e9 \u{1F44D}\u{1F3FD} \u05E9\u05DC\u05D5\u05DD')).toBe('caf\u00e9 \u{1F44D}\u{1F3FD} \u05E9\u05DC\u05D5\u05DD');
  });

  it('strips whole terminal escape sequences from the note, not just their control characters', () => {
    const note = (raw: string): string | undefined => {
      const parsed = parseDecisionFile(JSON.stringify({ decision: 'b', note: raw }), ['a', 'b']);
      return parsed.ok ? parsed.decision.note : undefined;
    };
    expect(note('\u001b[1;31mnot a bug\u001b[0m')).toBe('not a bug');
    expect(note('\u009b31mnot a bug')).toBe('not a bug');
    expect(note('\u001b]0;window title\u0007not a bug')).toBe('not a bug');
    expect(note('\u001b]8;;https://example.test\u001b\\not a bug\u001b]8;;\u001b\\')).toBe('not a bug');
    expect(note('not a bug\u001b]0;never terminated')).toBe('not a bug');
    expect(note(`${'x'.repeat(DECISION_NOTE_MAX)}\u001b[38;5;196m`)).toBe('x'.repeat(DECISION_NOTE_MAX));
  });

  it('drops a note with nothing to show', () => {
    expect(parseDecisionFile('{"decision":"b","note":""}', ['a', 'b'])).toEqual({ ok: true, decision: { value: 'b' } });
    expect(parseDecisionFile(JSON.stringify({ decision: 'b', note: ' \u0007 ' }), ['a', 'b'])).toEqual({ ok: true, decision: { value: 'b' } });
  });

  it('refuses a note that is not text, rather than dropping it', () => {
    for (const note of ['42', '[]', '{}', 'true', 'null']) {
      expect(parseDecisionFile(`{"decision":"b","note":${note}}`, ['a', 'b'])).toEqual({ ok: false, problem: 'note-not-text' });
    }
  });

  it('refuses a field other than decision and note, so a misnamed note is never lost without a word', () => {
    expect(parseDecisionFile('{"decision":"b","notes":"why"}', ['a', 'b'])).toEqual({ ok: false, problem: 'unknown-field' });
    expect(parseDecisionFile('{"decision":"b","note":"why","extra":1}', ['a', 'b'])).toEqual({ ok: false, problem: 'unknown-field' });
  });

  it('refuses a file larger than a decision file may be, whatever it holds', () => {
    const padded = JSON.stringify({ decision: 'b', pad: 'x'.repeat(DECISION_FILE_MAX_BYTES) });
    expect(parseDecisionFile(padded, ['a', 'b'])).toEqual({ ok: false, problem: 'too-large' });
  });
});

