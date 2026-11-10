// §27.3 — the progress file a goal session keeps. The goal prompt that tells the session how to write it and
// the engine that reads it at the done-signal both take the vocabulary from here, so the two cannot drift.

import { readJsonObject } from './jsonArtifact';
import { isOneOf } from './oneOf';

export const GOAL_PROGRESS_STATUSES = ['working', 'checkpoint', 'done', 'blocked'] as const;
export type GoalProgressStatus = (typeof GOAL_PROGRESS_STATUSES)[number];

/** The JSON keys of the progress file. */
export const GOAL_PROGRESS_FIELDS = {
  leg: 'leg',
  status: 'status',
  passes: 'reviewPassesThisLeg',
  blocked: 'blocked',
} as const;

export interface GoalProgress {
  leg: number;
  status: GoalProgressStatus;
  /** What the session needs from the operator; present only when blocked. */
  blocked: string | null;
}

export type GoalProgressRead = { ok: true; progress: GoalProgress } | { ok: false; problem: string };

const MAX_LEG = 1_000_000_000;

function isStatus(v: unknown): v is GoalProgressStatus {
  return isOneOf(GOAL_PROGRESS_STATUSES, v);
}

/** The progress file read, or what is wrong with it. The problem is fixed text, never the file's own. */
export function readGoalProgress(text: string): GoalProgressRead {
  const f = GOAL_PROGRESS_FIELDS;
  const read = readJsonObject(text);
  if (!read.ok) return read;
  const record = read.doc;
  const leg = record[f.leg];
  if (typeof leg !== 'number' || !Number.isInteger(leg) || leg < 1 || leg > MAX_LEG) {
    return { ok: false, problem: `its "${f.leg}" is not a positive whole number` };
  }
  const status = record[f.status];
  if (!isStatus(status)) return { ok: false, problem: `its "${f.status}" is not one of ${GOAL_PROGRESS_STATUSES.join(', ')}` };
  if (status !== 'blocked') return { ok: true, progress: { leg, status, blocked: null } };
  const blocked = record[f.blocked];
  if (typeof blocked !== 'string' || blocked.trim().length === 0) {
    return { ok: false, problem: `it is blocked but its "${f.blocked}" does not say what the session needs` };
  }
  return { ok: true, progress: { leg, status, blocked: blocked.trim() } };
}

/** Whether the progress file ends the leg the session is on: well-formed, on this leg, and past `working`
 *  (a checkpoint only where the goal runs in legs). The engine at the done-signal and the agent's own check
 *  both decide by this. */
export function goalLegEnd(text: string, at: { leg: number; legs: boolean }): GoalProgressRead {
  const read = readGoalProgress(text);
  if (!read.ok) return { ok: false, problem: `it is not well-formed: ${read.problem}` };
  const { leg, status } = read.progress;
  if (leg !== at.leg) return { ok: false, problem: `it records leg ${leg}, not this leg (${at.leg})` };
  if (status === 'working') return { ok: false, problem: 'it records the goal as still working' };
  if (status === 'checkpoint' && !at.legs) return { ok: false, problem: 'it records a checkpoint, but this goal runs in one leg' };
  return read;
}

export function parseGoalProgress(text: string): GoalProgress | null {
  const read = readGoalProgress(text);
  return read.ok ? read.progress : null;
}

export function exampleGoalProgress(leg: number, status: GoalProgressStatus): string {
  const f = GOAL_PROGRESS_FIELDS;
  return `${JSON.stringify(
    {
      [f.leg]: leg,
      [f.status]: status,
      [f.passes]: 2,
      ...(status === 'blocked' ? { [f.blocked]: 'The plan asks for both a modal and a page, and they cannot both ship. Which one?' } : {}),
    },
    null,
    2,
  )}\n`;
}

/** The session's own notes, which the engine never reads: only the next leg does, to resume. */
export function exampleGoalNotes(): string {
  return [
    '# Goal notes',
    '',
    '## Done so far',
    '- The slice is wired and its tests pass.',
    '',
    '## Open findings',
    '- impl-review-tests: the empty-list case has no test.',
    '',
    '## Next',
    '- Add the empty-list test, then run review pass 3.',
    '',
  ].join('\n');
}
