import { createHash } from 'node:crypto';
import type { RosterEntry } from './reviewTurn';

const RUN_REVIEWER_PREFIX = 'agent-terminal--';
const RUN_REVIEWER_EXTENSION = '.md';
const RUN_REVIEWER_HASH = /^[0-9a-f]{32}$/;

export const RUN_REVIEWER_FILE_GLOB = `${RUN_REVIEWER_PREFIX}*${RUN_REVIEWER_EXTENSION}`;

export function resolvedReviewerName(reviewer: RosterEntry): string {
  const identity = JSON.stringify([reviewer.loop, reviewer.persona, reviewer.charter, reviewer.tools]);
  return `${RUN_REVIEWER_PREFIX}${createHash('sha256').update(identity).digest('hex').slice(0, 32)}`;
}

export function resolvedReviewerFile(reviewer: RosterEntry): string {
  return `${resolvedReviewerName(reviewer)}${RUN_REVIEWER_EXTENSION}`;
}

export function isResolvedReviewerFile(name: string): boolean {
  if (!name.startsWith(RUN_REVIEWER_PREFIX) || !name.endsWith(RUN_REVIEWER_EXTENSION)) return false;
  return RUN_REVIEWER_HASH.test(name.slice(RUN_REVIEWER_PREFIX.length, -RUN_REVIEWER_EXTENSION.length));
}
