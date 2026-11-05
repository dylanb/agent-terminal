import type { SetupStatusReply } from '../../src/shared/ipc';
import type { SetupConditionEntry } from '../../src/shared/setupCheck';
import type { SetupCheckDialogDeps } from '../../src/renderer/src/setupCheckDialog';

/** Repository keys no two of which share a path segment, so a dialog naming one cannot be read as naming
 *  another. */
export const REPO = {
  alpha: '/work/alpha-orchard',
  bravo: '/srv/bravo-quarry',
  charlie: '/home/op/charlie-delta',
} as const;

/** One entry per failure kind the slice lists. */
export const ENTRY = {
  absent: { condition: 'capabilities', failure: 'absent' },
  malformed: { condition: 'capabilities', failure: 'malformed' },
  confinement: { condition: 'capabilities', failure: 'confinement' },
  notIgnored: { condition: 'ignore', failure: 'not-ignored' },
  unchecked: { condition: 'ignore', failure: 'unchecked' },
} as const satisfies Record<string, SetupConditionEntry>;

export const repoStatus = (repoKey: string, entries: SetupConditionEntry[]): SetupStatusReply => ({
  ok: true,
  repoKey,
  isRepository: true,
  entries,
});

type Scripted = SetupStatusReply | { reject: string };

/** The dialog's deps over scripted status replies, consumed in order per repository key; an unscripted key
 *  answers a failed reply. */
export function fakeSetupDeps() {
  const scripts = new Map<string, Scripted[]>();
  const deps: SetupCheckDialogDeps = {
    status: async (repoKey) => {
      const next = scripts.get(repoKey)?.shift();
      if (next === undefined) return { ok: false, reason: `no status scripted for ${repoKey}` };
      if ('reject' in next) throw new Error(next.reject);
      return next;
    },
  };
  return {
    deps,
    /** Queue the replies the next status requests for `repoKey` get, in order. */
    answer(repoKey: string, ...replies: Scripted[]): void {
      scripts.set(repoKey, [...(scripts.get(repoKey) ?? []), ...replies]);
    },
  };
}
