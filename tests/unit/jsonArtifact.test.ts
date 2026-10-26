import { describe, expect, it } from 'vitest';
import { readJsonObject } from '../../src/shared/jsonArtifact';
import { readGoalProgress } from '../../src/shared/goalProgress';
import { readPhaseResult } from '../../src/shared/phaseResult';
import { consolidatorOutputProblems } from '../../src/shared/consolidatorOutput';
import { roundReportProblems } from '../../src/shared/roundReport';

// §27.12 — every agent-written JSON artifact the engine gates on is read the same way: a byte order mark
// is tolerated, and text that is not a JSON object is named in the same fixed words, never the file's own.

describe('reading an agent-written JSON artifact', () => {
  it('reads an object, with or without a byte order mark', () => {
    expect(readJsonObject('{"a":1}')).toEqual({ ok: true, doc: { a: 1 } });
    expect(readJsonObject('﻿{"a":1}')).toEqual({ ok: true, doc: { a: 1 } });
  });

  it.each([
    ['not JSON', 'a: 1', 'it is not valid JSON'],
    ['a list', '[1]', 'it is not a JSON object'],
    ['null', 'null', 'it is not a JSON object'],
    ['a string', '"<script>"', 'it is not a JSON object'],
  ])('names %s in fixed words', (_what, text, problem) => {
    expect(readJsonObject(text)).toEqual({ ok: false, problem });
  });

  it('is how every gated artifact reads its file, so they all say the same thing about the same text', () => {
    for (const text of ['a: 1', '[1]']) {
      const want = (readJsonObject(text) as { ok: false; problem: string }).problem;
      expect(readGoalProgress(text)).toEqual({ ok: false, problem: want });
      expect(readPhaseResult(text)).toEqual({ ok: false, problem: want });
      expect(consolidatorOutputProblems(text, [])).toEqual([want]);
      expect(roundReportProblems(text, { sections: [], roster: [] })).toEqual([want]);
    }
  });
});
