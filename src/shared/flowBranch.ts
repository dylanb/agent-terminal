import { removeDisplayUnsafe } from './controlChars';
import { stepLabel } from './stepLabel';

export interface FlowDecision {
  value: string;
  note?: string;
}

export interface BranchStep {
  id: string;
  decides?: readonly string[];
  when?: { step: string; value: string };
}

export type StepRun = 'runs' | 'skipped' | 'unresolved';

export function stepRuns(steps: readonly BranchStep[], decisions: Readonly<Record<string, FlowDecision>>): StepRun[] {
  const runOf = new Map<string, StepRun>();
  return steps.map((step) => {
    const run = runFor(step, runOf, decisions);
    runOf.set(step.id, run);
    return run;
  });
}

function runFor(step: BranchStep, earlier: ReadonlyMap<string, StepRun>, decisions: Readonly<Record<string, FlowDecision>>): StepRun {
  if (step.when === undefined) return 'runs';
  const decider = earlier.get(step.when.step);
  if (decider === 'skipped' || decider === 'unresolved') return decider;
  if (!Object.prototype.hasOwnProperty.call(decisions, step.when.step)) return 'unresolved';
  return decisions[step.when.step].value === step.when.value ? 'runs' : 'skipped';
}

export const DECISION_PROBLEMS = ['missing', 'unreadable', 'too-large', 'not-json', 'no-decision-field', 'unknown-field', 'undeclared-value', 'note-not-text', 'note-too-long', 'no-decision-output', 'loop-unresolved', 'flow-unresolved'] as const;
export type DecisionProblem = (typeof DECISION_PROBLEMS)[number];

export const DECISION_NOTE_MAX = 60;

export const DECISION_FILE_MAX_BYTES = 4096;

const PROBLEM_TEXT: Record<DecisionProblem, string> = {
  missing: 'the decision file is missing',
  unreadable: 'the decision file could not be read',
  'too-large': `the decision file is larger than ${DECISION_FILE_MAX_BYTES} bytes`,
  'not-json': 'the decision file is not JSON',
  'no-decision-field': 'the decision file names no decision',
  'unknown-field': 'the decision file holds a field other than decision and note',
  'undeclared-value': 'decision value is not one this step declares',
  'note-not-text': 'the decision note is not text',
  'note-too-long': `the decision note is longer than ${DECISION_NOTE_MAX} characters`,
  'no-decision-output': 'the step decides a value but its loop names no decision output',
  'loop-unresolved': 'the step decides a value but its loop could not be loaded',
  'flow-unresolved': 'the flow definition could not be loaded, so the step\'s decision cannot be read',
};

export function decisionProblemText(p: DecisionProblem): string {
  return PROBLEM_TEXT[p];
}

export function decisionNote(raw: string): { ok: true; note?: string } | { ok: false } {
  const note = removeDisplayUnsafe(raw).trim();
  if ([...note].length > DECISION_NOTE_MAX) return { ok: false };
  return note === '' ? { ok: true } : { ok: true, note };
}

export type DecisionFileRead = { ok: true; decision: FlowDecision } | { ok: false; problem: DecisionProblem };

export function parseDecisionFile(text: string, allowed: readonly string[]): DecisionFileRead {
  if (new TextEncoder().encode(text).length > DECISION_FILE_MAX_BYTES) return { ok: false, problem: 'too-large' };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'not-json' };
  }
  if (typeof doc !== 'object' || doc === null || !('decision' in doc) || typeof doc.decision !== 'string') return { ok: false, problem: 'no-decision-field' };
  if (!Object.keys(doc).every((key) => key === 'decision' || key === 'note')) return { ok: false, problem: 'unknown-field' };
  if (!allowed.includes(doc.decision)) return { ok: false, problem: 'undeclared-value' };
  if ('note' in doc && typeof doc.note !== 'string') return { ok: false, problem: 'note-not-text' };
  const note = 'note' in doc && typeof doc.note === 'string' ? decisionNote(doc.note) : { ok: true as const };
  if (!note.ok) return { ok: false, problem: 'note-too-long' };
  return { ok: true, decision: { value: doc.decision, ...(note.note !== undefined ? { note: note.note } : {}) } };
}

export function exampleDecisionFile(value: string, note?: string): string {
  return JSON.stringify(note === undefined ? { decision: value } : { decision: value, note });
}

export function undecidedAdvanceNotice(decider: string): string {
  return `Not advanced: ${stepLabel(decider)} has not decided yet, and its decision is recorded when its gate is approved.`;
}
