// OS attention notification (§24.2.3 T4). This surface only flags a human-needed stop; it must never
// inject or drive agent-loop — the human does that by hand.

import type { FlowStateView } from '../shared/ipc';
import { sameOccurrence, type Occurrence } from '../shared/occurrence';
import { stripStatusControlChars } from '../shared/loopStatus';

export interface LoopNotifyOpts {
  title: string;
  body: string;
  /** The repo whose loop raised this: tags the §25 record when the OS refuses to deliver it. */
  repoKey: string;
  onActivate: () => void;
}

export interface LoopNotifierDeps {
  isFocused: () => boolean;
  /** The window gained or lost focus. Losing it is what makes a pending entry worth raising. */
  onFocusChanged: (listener: () => void) => void;
  /** Returns a closer that dismisses the raised notification. */
  notify: (opts: LoopNotifyOpts) => () => void;
  focusWindow: () => void;
  reveal: () => void;
}

export interface LoopNotifier {
  observe(repoKey: string, view: FlowStateView): void;
}

// §16.3: bound the untrusted `status` length for the OS notification; the CWE-117 control-character
// strip is the shared `stripStatusControlChars` so this sink and the audit record cannot drift.
const STATUS_MAX = 80;
const sanitizeStatus = (status: string): string => stripStatusControlChars(status).slice(0, STATUS_MAX);

export function createLoopNotifier(deps: LoopNotifierDeps): LoopNotifier {
  // Both maps are per repo (§16.3): a same-repo return visit after a detour to another repo must stay
  // deduped; a single shared slot would re-fire it.
  // `pending` is the repo's current human-needed entry; `lastRaised` is the last one the OS was asked to
  // show. They differ exactly while an entry is waiting for the user to look away — an entry skipped for
  // focus is NOT signalled, or leaving the app (the moment the notification earns its keep) would find it
  // already deduped and stay silent forever.
  const pending = new Map<string, Occurrence>();
  const lastRaised = new Map<string, Occurrence>();
  let closeActive: (() => void) | null = null;
  let activeRepoKey: string | null = null;
  let observedRepoKey: string | null = null;

  const clearActive = (): void => {
    closeActive?.();
    closeActive = null;
    activeRepoKey = null;
  };

  const raiseIfDue = (repoKey: string): void => {
    const occ = pending.get(repoKey);
    if (!occ) return;
    if (sameOccurrence(lastRaised.get(repoKey) ?? null, occ)) return;
    clearActive(); // whatever is showing describes an entry the loop has moved past
    if (deps.isFocused()) return;
    lastRaised.set(repoKey, occ);
    closeActive = deps.notify({
      title: 'Agent loop needs you',
      body: `${sanitizeStatus(occ.status)} · iter ${occ.iteration}`,
      repoKey,
      onActivate: () => {
        deps.focusWindow();
        deps.reveal();
      },
    });
    activeRepoKey = repoKey;
  };

  // A view is only recomputed when the loop moves, so focus alone would never re-run the decision.
  deps.onFocusChanged(() => {
    if (observedRepoKey !== null) raiseIfDue(observedRepoKey);
  });

  return {
    observe(repoKey, view) {
      observedRepoKey = repoKey;
      const loop = view.loop;
      if (!loop || loop.humanNeeded !== true) {
        pending.delete(repoKey);
        if (activeRepoKey === repoKey) clearActive();
        return;
      }
      pending.set(repoKey, { repoKey, status: loop.status, iteration: loop.iteration });
      raiseIfDue(repoKey);
    },
  };
}
