// §27.3 — the progress file a goal session keeps. The goal prompt that tells the session how to write it and
// the engine that reads it at the done-signal both take the vocabulary from here, so the two cannot drift.

import { stripLeadingBullet } from './markdownFields';

export const GOAL_PROGRESS_STATUSES = ['working', 'checkpoint', 'done', 'blocked'] as const;
export type GoalProgressStatus = (typeof GOAL_PROGRESS_STATUSES)[number];

export const GOAL_PROGRESS_GRAMMAR = {
  legLabel: 'Leg',
  statusLabel: 'Status',
  passesLabel: 'Review passes this leg',
  blockedHeading: '## Blocked',
} as const;

export interface GoalProgress {
  leg: number;
  status: GoalProgressStatus;
  /** What the session needs from the operator; present only when blocked. */
  blocked: string | null;
}

const MARKUP = '`*_';

function unmarked(v: string): string {
  let a = 0;
  let b = v.length;
  while (a < b && (MARKUP.includes(v[a]) || v[a] === ' ')) a++;
  while (b > a && (MARKUP.includes(v[b - 1]) || v[b - 1] === ' ')) b--;
  return v.slice(a, b);
}

const TRAILING = '.,;:!';

/** The value's first word in lower case, with what follows it (punctuation, a note) set aside. */
function firstWord(v: string): string {
  let end = 0;
  while (end < v.length && ((v[end] >= 'a' && v[end] <= 'z') || (v[end] >= 'A' && v[end] <= 'Z'))) end++;
  return v.slice(0, end).toLowerCase();
}

function withoutTrailingPunctuation(v: string): string {
  let end = v.length;
  while (end > 0 && TRAILING.includes(v[end - 1])) end--;
  return v.slice(0, end);
}

/** A `label: value` field with any code-span or emphasis markup around the label or the value set aside. */
function plainField(line: string, label: string): string | null {
  const t = stripLeadingBullet(line.trim());
  const idx = t.indexOf(':');
  if (idx < 0 || unmarked(t.slice(0, idx)) !== label) return null;
  return unmarked(t.slice(idx + 1));
}

function isStatus(v: string): v is GoalProgressStatus {
  return (GOAL_PROGRESS_STATUSES as readonly string[]).includes(v);
}

function positiveWhole(v: string): number | null {
  if (v.length === 0 || v.length > 9) return null;
  for (const c of v) if (c < '0' || c > '9') return null;
  const n = Number(v);
  return n >= 1 ? n : null;
}

function sectionBody(lines: readonly string[], heading: string): string | null {
  const at = lines.findIndex((l) => {
    const t = l.trim();
    if (!t.startsWith(heading)) return false;
    const next = t.slice(heading.length, heading.length + 1);
    return next === '' || next === ':' || next === ' ';
  });
  if (at < 0) return null;
  const body: string[] = [];
  for (let i = at + 1; i < lines.length && !lines[i].trimStart().startsWith('#'); i++) body.push(lines[i]);
  const text = body.join('\n').trim();
  return text.length > 0 ? text : null;
}

export function parseGoalProgress(text: string): GoalProgress | null {
  const lines = text.split('\n');
  let leg: number | null = null;
  let status: string | null = null;
  for (const line of lines) {
    if (leg === null) {
      const v = plainField(line, GOAL_PROGRESS_GRAMMAR.legLabel);
      if (v !== null) {
        leg = positiveWhole(withoutTrailingPunctuation(v));
        if (leg === null) return null;
        continue;
      }
    }
    if (status === null) {
      const v = plainField(line, GOAL_PROGRESS_GRAMMAR.statusLabel);
      if (v !== null) status = firstWord(v);
    }
  }
  if (leg === null || status === null || !isStatus(status)) return null;
  if (status !== 'blocked') return { leg, status, blocked: null };
  const blocked = sectionBody(lines, GOAL_PROGRESS_GRAMMAR.blockedHeading);
  return blocked === null ? null : { leg, status, blocked };
}

export function exampleGoalProgress(leg: number, status: GoalProgressStatus): string {
  const g = GOAL_PROGRESS_GRAMMAR;
  return [
    '# Goal progress',
    '',
    `- ${g.legLabel}: ${leg}`,
    `- ${g.statusLabel}: ${status}`,
    `- ${g.passesLabel}: 2`,
    '',
    ...(status === 'blocked' ? [g.blockedHeading, 'The plan asks for both a modal and a page, and they cannot both ship. Which one?', ''] : []),
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
