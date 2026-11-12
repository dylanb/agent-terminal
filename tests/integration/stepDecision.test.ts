import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFlowStepDecision, readStepDecision } from '../../src/main/stepDecision';
import { DECISION_FILE_MAX_BYTES, decisionProblemText } from '../../src/shared/flowBranch';
import type { FlowStepDef } from '../../src/main/flow';
import type { LoopDefV2 } from '../../src/main/loopDefV2';

describe('readStepDecision', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'step-decision-'));
    file = join(dir, 'verdict.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const triage: FlowStepDef = { id: 'triage', kind: 'loop', loop: 'groom-loop', decides: ['a', 'b'], haltOnDecision: ['a'] };
  const plain: FlowStepDef = { id: 'plan', kind: 'loop', loop: 'plan-loop' };
  const def = (decision?: { output: string }): LoopDefV2 =>
    ({ outputs: [{ id: 'verdict', path: file, rel: 'verdict.json' }], ...(decision ? { decision: { ...decision, path: file, rel: 'verdict.json' } } : {}) }) as unknown as LoopDefV2;

  it('reads nothing for a step that decides nothing or is not in the flow', () => {
    writeFileSync(file, '{"decision":"b"}');
    expect(readStepDecision([triage, plain], 'plan', def({ output: 'verdict' }))).toEqual({ kind: 'none' });
    expect(readStepDecision([triage, plain], 'gone', def({ output: 'verdict' }))).toEqual({ kind: 'none' });
  });

  it('refuses a deciding step whose loop does not load, and reads nothing for a step that decides nothing', () => {
    writeFileSync(file, '{"decision":"b"}');
    expect(readStepDecision([triage, plain], 'triage', null)).toEqual({ kind: 'invalid', problem: 'loop-unresolved' });
    expect(readStepDecision([triage, plain], 'plan', null)).toEqual({ kind: 'none' });
  });

  it('refuses a deciding step whose loop names no decision output', () => {
    writeFileSync(file, '{"decision":"b"}');
    expect(readStepDecision([triage], 'triage', def())).toEqual({ kind: 'invalid', problem: 'no-decision-output' });
  });

  it('reports a missing decision file', () => {
    expect(readStepDecision([triage], 'triage', def({ output: 'verdict' }))).toEqual({ kind: 'invalid', problem: 'missing' });
  });

  it('refuses a decision file too large to be one', () => {
    writeFileSync(file, `{"decision":"b","note":"${'x'.repeat(DECISION_FILE_MAX_BYTES)}"}`);
    expect(readStepDecision([triage], 'triage', def({ output: 'verdict' }))).toEqual({ kind: 'invalid', problem: 'too-large' });
  });

  it('reports a decision path that is a symlink or a directory as unreadable, not missing', () => {
    const target = join(dir, 'elsewhere.json');
    writeFileSync(target, '{"decision":"b"}');
    symlinkSync(target, file);
    expect(readStepDecision([triage], 'triage', def({ output: 'verdict' }))).toEqual({ kind: 'invalid', problem: 'unreadable' });
    rmSync(file);
    mkdirSync(file);
    expect(readStepDecision([triage], 'triage', def({ output: 'verdict' }))).toEqual({ kind: 'invalid', problem: 'unreadable' });
  });

  it.skipIf(process.getuid?.() === 0)('reports a decision file it has no permission to read as unreadable', () => {
    writeFileSync(file, '{"decision":"b"}');
    chmodSync(file, 0o000);
    expect(readStepDecision([triage], 'triage', def({ output: 'verdict' }))).toEqual({ kind: 'invalid', problem: 'unreadable' });
  });

  it('reads the decision and whether its value halts an auto gate', () => {
    writeFileSync(file, '{"decision":"b","note":"feature request"}');
    expect(readStepDecision([triage], 'triage', def({ output: 'verdict' }))).toEqual({
      kind: 'ok',
      decision: { value: 'b', note: 'feature request' },
      haltsAuto: false,
    });
    writeFileSync(file, '{"decision":"a"}');
    expect(readStepDecision([triage], 'triage', def({ output: 'verdict' }))).toEqual({ kind: 'ok', decision: { value: 'a' }, haltsAuto: true });
  });

  it('refuses the decision of any step while the flow definition does not load, naming the flow as the cause', () => {
    writeFileSync(file, '{"decision":"b"}');
    for (const step of ['triage', 'plan']) {
      const read = readFlowStepDecision({ ok: false, error: 'flow.yaml: bad indentation' }, step, def({ output: 'verdict' }));
      expect(read.kind, step).toBe('invalid');
      if (read.kind === 'invalid') expect(decisionProblemText(read.problem), step).toMatch(/flow definition could not be loaded/);
    }
  });

  it('reads the decision through a flow definition that loads', () => {
    writeFileSync(file, '{"decision":"b"}');
    const load = { ok: true as const, definition: { name: 'f', steps: [triage, plain] }, flowDir: dir };
    expect(readFlowStepDecision(load, 'triage', def({ output: 'verdict' }))).toEqual({ kind: 'ok', decision: { value: 'b' }, haltsAuto: false });
    expect(readFlowStepDecision(load, 'plan', def({ output: 'verdict' }))).toEqual({ kind: 'none' });
  });
});
