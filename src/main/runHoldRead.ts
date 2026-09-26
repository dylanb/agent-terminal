// §18.7.3 / §18.7.4

import { classifyRunHold, type RunRecordRead } from '../shared/runHold';
import type { HeldRead } from './heldRunRecovery';
import { readDisposition, readRunBinding } from './runDisposition';
import { readProgression } from './startedness';

function runRecordRead(worktree: string): RunRecordRead {
  const presence = readDisposition(worktree);
  if (presence === 'absent') return 'missing';
  if (presence === 'indeterminate') return 'unreadable';
  return readRunBinding(worktree) === null ? 'unreadable' : 'intact';
}

export function heldRunOf(worktree: string): HeldRead {
  const progression = readProgression(worktree);
  const hold = classifyRunHold(progression.kind, runRecordRead(worktree));
  if (hold === 'not-held' || progression.kind !== 'begun') return { hold: 'not-held' };
  return { hold, step: progression.step, status: progression.status };
}
