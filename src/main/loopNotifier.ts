import { randomUUID } from 'node:crypto';
import type { FlowStateView } from '../shared/ipc';
import { sameOccurrence, type Occurrence } from '../shared/occurrence';
import { stripStatusControlChars } from '../shared/loopStatus';
import type { ControllerNotificationSource, NotificationCondition } from '../shared/controllerProtocol';

export interface LoopNotifyOpts { title: string; body: string; repoKey: string }
export interface LoopNotifierDeps {
  notify?: (opts: LoopNotifyOpts) => void;
  isFocused?: () => boolean;
  onFocusChanged?: (listener: () => void) => void;
  focusWindow?: () => void;
  reveal?: () => void;
}
export interface LoopNotifier extends ControllerNotificationSource {
  observe(repoKey: string, view: FlowStateView): void;
  current(repoKey?: string): NotificationCondition | null;
}
const STATUS_MAX = 80;

export function createLoopNotifier(deps: LoopNotifierDeps = {}): LoopNotifier {
  const lastRaised = new Map<string, Occurrence & { perStep: boolean }>();
  const conditions = new Map<string, NotificationCondition>();
  const listeners = new Set<(notification: NotificationCondition) => void>();
  let observedRepoKey: string | undefined;
  return {
    current(repoKey = observedRepoKey) {
      const condition = repoKey === undefined ? undefined : conditions.get(repoKey);
      return condition ? { ...condition } : null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    observe(repoKey, view) {
      observedRepoKey = repoKey;
      const loop = view.loop;
      if (!loop || loop.humanNeeded !== true) {
        conditions.delete(repoKey);
        if (loop?.autoGate !== undefined || lastRaised.get(repoKey)?.perStep) lastRaised.delete(repoKey);
        return;
      }
      const raised = lastRaised.get(repoKey);
      const occurrence = loop.autoGate !== undefined && raised !== undefined
        ? raised : { repoKey, status: loop.status, iteration: loop.iteration };
      const message = stripStatusControlChars(occurrence.status).slice(0, STATUS_MAX)
        + (occurrence.iteration === undefined ? '' : ` · iter ${occurrence.iteration}`);
      if (!conditions.has(repoKey) || !sameOccurrence(raised ?? null, occurrence)) {
        conditions.set(repoKey, { conditionId: randomUUID(), message });
      }
      if (sameOccurrence(raised ?? null, occurrence)) return;
      lastRaised.set(repoKey, { ...occurrence, perStep: loop.autoGate !== undefined });
      const condition = conditions.get(repoKey)!;
      try { deps.notify?.({ title: 'Agent loop needs you', body: message, repoKey }); }
      catch { /* A notification cannot interrupt terminal work. */ }
      for (const listener of listeners) {
        try { listener({ ...condition }); }
        catch { /* Each notification consumer is best effort. */ }
      }
    },
  };
}
