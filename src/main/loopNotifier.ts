// OS attention notification (§24.2.3 T4). This surface only flags a human-needed stop; it must never
// inject or drive agent-loop — the human does that by hand.

import type { FlowStateView } from '../shared/ipc';
import { sameOccurrence, type Occurrence } from '../shared/occurrence';

export interface LoopNotifyOpts {
  title: string;
  body: string;
  onActivate: () => void;
}

export interface LoopNotifierDeps {
  isFocused: () => boolean;
  /** Returns a closer that dismisses the raised notification. */
  notify: (opts: LoopNotifyOpts) => () => void;
  focusWindow: () => void;
  reveal: () => void;
}

export interface LoopNotifier {
  observe(repoKey: string, view: FlowStateView): void;
}

// CWE-117: `status` originates in an arbitrary repo's untrusted `.agent-loop/state.yaml` (§16.3);
// bound its length and strip control characters before it reaches the OS notification sink.
const STATUS_MAX = 80;
const sanitizeStatus = (status: string): string =>
  status.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, STATUS_MAX);

export function createLoopNotifier(deps: LoopNotifierDeps): LoopNotifier {
  // Per repo (§16.3): a same-repo return visit after a detour to another repo must stay deduped; a
  // single shared slot would re-fire it.
  const lastSignalled = new Map<string, Occurrence>();
  let closeActive: (() => void) | null = null;
  let activeRepoKey: string | null = null;

  const clearActive = (): void => {
    closeActive?.();
    closeActive = null;
    activeRepoKey = null;
  };

  return {
    observe(repoKey, view) {
      const loop = view.loop;
      if (!loop || loop.humanNeeded !== true) {
        if (activeRepoKey === repoKey) clearActive();
        return;
      }
      const occ: Occurrence = { repoKey, status: loop.status, iteration: loop.iteration };
      if (sameOccurrence(lastSignalled.get(repoKey) ?? null, occ)) return;
      lastSignalled.set(repoKey, occ);
      clearActive();
      if (deps.isFocused()) return;
      closeActive = deps.notify({
        title: 'Agent loop needs you',
        body: `${sanitizeStatus(loop.status)} · iter ${loop.iteration}`,
        onActivate: () => {
          deps.focusWindow();
          deps.reveal();
        },
      });
      activeRepoKey = repoKey;
    },
  };
}
