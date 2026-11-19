import { rmSync } from 'node:fs';
import { readBoundedNoFollow, type BoundedRead } from './boundedRead';
import { DECISION_FILE_MAX_BYTES, parseDecisionFile, type DecisionFileRead, type DecisionProblem, type FlowDecision } from '../shared/flowBranch';
import type { FlowLoad, FlowStepDef } from './flow';
import { decisionOutput, type LoopDefV2 } from './loopDefV2';

const READ_PROBLEM: Record<Extract<BoundedRead, { ok: false }>['cause'], DecisionProblem> = {
  absent: 'missing',
  'over-cap': 'too-large',
  unreadable: 'unreadable',
};

export type StepDecisionRead = { kind: 'none' } | { kind: 'ok'; decision: FlowDecision; haltsAuto: boolean } | { kind: 'invalid'; problem: DecisionProblem };

export function readDecisionFile(file: string, values: readonly string[]): DecisionFileRead {
  const read = readBoundedNoFollow(file, DECISION_FILE_MAX_BYTES);
  if (!read.ok) return { ok: false, problem: READ_PROBLEM[read.cause] };
  return parseDecisionFile(read.text, values);
}

export function readStepDecision(steps: readonly FlowStepDef[], step: string, def: LoopDefV2 | null): StepDecisionRead {
  const deciding = steps.find((s) => s.id === step);
  if (deciding?.decides === undefined) return { kind: 'none' };
  if (def === null) return { kind: 'invalid', problem: 'loop-unresolved' };
  const output = decisionOutput(def);
  if (output === undefined) return { kind: 'invalid', problem: 'no-decision-output' };
  const parsed = readDecisionFile(output.path, deciding.decides);
  if (!parsed.ok) return { kind: 'invalid', problem: parsed.problem };
  return { kind: 'ok', decision: parsed.decision, haltsAuto: (deciding.haltOnDecision ?? []).includes(parsed.decision.value) };
}

export function readFlowStepDecision(load: FlowLoad, step: string, def: LoopDefV2 | null): StepDecisionRead {
  if (!load.ok) return { kind: 'invalid', problem: 'flow-unresolved' };
  return readStepDecision(load.definition.steps, step, def);
}

export function clearDecisionFile(file: string): void {
  rmSync(file, { force: true });
}
