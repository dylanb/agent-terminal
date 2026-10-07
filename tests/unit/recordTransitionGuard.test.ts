import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SRC_MAIN, functionBody, stripComments, tsFilesUnder } from '../helpers/sourceScan';

// §27.9.1 N9b.5(d) — plan row "Run end with a marker" (#137 S2): every flow transition reaches the §25 recorder
// through `composeRecordFlowTransition`, which also tells the gate controller the run moved, so a run ending with
// a failed-effect marker set is reported whichever path advanced it. A supplement to the behavioural legs in
// `integration/autoGate.test.ts`, not the proof.

const CALL = /\baudit\??\.recordTransition\s*\(/g;
const COMPOSITION = path.join(SRC_MAIN, 'autoGateComposition.ts');
const RECORDER = path.join(SRC_MAIN, 'auditRecorder.ts');

describe('recordTransition guard — the §25 transition recorder is called only through composeRecordFlowTransition', () => {
  it('no `src/main` file outside the composition and the recorder itself calls `audit.recordTransition(`', () => {
    const offenders = tsFilesUnder(SRC_MAIN)
      .filter((f) => f !== COMPOSITION && f !== RECORDER)
      .flatMap((f) => {
        const n = [...stripComments(readFileSync(f, 'utf8')).matchAll(CALL)].length;
        return n > 0 ? [`${path.relative(SRC_MAIN, f)} (${n})`] : [];
      });
    expect(offenders).toEqual([]);
  });

  it('inside the composition, the only call is in `composeRecordFlowTransition`', () => {
    const src = stripComments(readFileSync(COMPOSITION, 'utf8'));
    const body = functionBody(src, 'composeRecordFlowTransition');
    expect(body).not.toBe('');
    expect([...body.matchAll(CALL)].length).toBeGreaterThan(0);
    expect([...src.matchAll(CALL)].length).toBe([...body.matchAll(CALL)].length);
  });
});
