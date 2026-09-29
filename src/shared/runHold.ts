// §18.7.3 / §18.7.4

import type { FlowStatus } from './ipc';
import { displaySafeEcho, MAX_ECHOED_REASON_LENGTH } from './controlChars';

export type ProgressionBegunness = 'begun' | 'not-begun' | 'indeterminate';
export type RunRecordRead = 'intact' | 'missing' | 'unreadable';
export type RunHold = 'not-held' | 'record-missing' | 'record-unreadable';

export type BegunStatus = 'in_progress' | 'done';

export type HeldRunView =
  | { hold: 'not-held' }
  | { hold: 'record-missing' | 'record-unreadable'; step: string; status: BegunStatus };

export function isBegunStatus(status: FlowStatus): status is BegunStatus {
  return status === 'in_progress' || status === 'done';
}

export function classifyRunHold(progression: ProgressionBegunness, record: RunRecordRead): RunHold {
  if (progression !== 'begun') return 'not-held';
  if (record === 'missing') return 'record-missing';
  if (record === 'unreadable') return 'record-unreadable';
  return 'not-held';
}

export function offersHeldRunRecovery(v: HeldRunView): v is Exclude<HeldRunView, { hold: 'not-held' }> {
  return v.hold !== 'not-held';
}

/** §18.7.6 — the held step is repo-controlled text: this is the copy the flow view shows, and the one an operator's
 *  consent to end the run names (§6). */
export function shownHeldStep(step: string): string {
  return displaySafeEcho(step, MAX_ECHOED_REASON_LENGTH);
}
