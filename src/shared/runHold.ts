// §18.7.3 / §18.7.4

import type { FlowCatalogListing, FlowStatus, RebindChoice } from './ipc';

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

/** The flows a held run's recovery picker offers, in the order it lists them. */
export function recoveryChoices(listing: Pick<FlowCatalogListing, 'hasLocalFlow' | 'resumable' | 'hasGlobalFallback'>): RebindChoice[] {
  return [
    ...(listing.hasLocalFlow ? [{ origin: 'local' } as const] : []),
    ...listing.resumable.map(({ origin, id }) => ({ origin, id })),
    ...(listing.hasGlobalFallback ? [{ origin: 'fallback' } as const] : []),
  ];
}

export function sameRebindChoice(a: RebindChoice, b: RebindChoice): boolean {
  return a.origin === b.origin && ('id' in a ? a.id : undefined) === ('id' in b ? b.id : undefined);
}
