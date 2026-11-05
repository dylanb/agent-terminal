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
 *  answers a failed reply. Another app dialog is modelled by `otherDialog`, and `onFocusLost` lands focus on
 *  whatever `landFocusOn` names, as the composition root's fallback does. */
export function fakeSetupDeps() {
  const scripts = new Map<string, Scripted[]>();
  const deliveries = new Map<string, Array<() => void>>();
  const holds = new Map<string, Promise<void>>();
  let blocking = false;
  const closedListeners = new Set<() => void>();
  let landing: HTMLElement | null = null;
  const deps: SetupCheckDialogDeps = {
    status: async (repoKey) => {
      const held = holds.get(repoKey);
      if (held !== undefined) {
        holds.delete(repoKey);
        await held;
      }
      const next = scripts.get(repoKey)?.shift();
      for (const resolve of deliveries.get(repoKey)?.splice(0) ?? []) queueMicrotask(resolve);
      if (next === undefined) return { ok: false, reason: `no status scripted for ${repoKey}` };
      if ('reject' in next) throw new Error(next.reject);
      return next;
    },
    onFocusLost: () => landing?.focus(),
    blockingDialogOpen: () => blocking,
    onBlockingDialogClosed: (cb) => {
      closedListeners.add(cb);
      return () => closedListeners.delete(cb);
    },
  };
  return {
    deps,
    /** Queue the replies the next status requests for `repoKey` get, in order. */
    answer(repoKey: string, ...replies: Scripted[]): void {
      scripts.set(repoKey, [...(scripts.get(repoKey) ?? []), ...replies]);
    },
    /** Settles once the next status request for `repoKey` has been answered and a task has run after it. */
    answered(repoKey: string): Promise<void> {
      return new Promise<void>((resolve) => {
        deliveries.set(repoKey, [...(deliveries.get(repoKey) ?? []), resolve]);
      }).then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    },
    /** Keeps the next status reply for `repoKey` pending until the returned release runs. */
    hold(repoKey: string): () => void {
      let release!: () => void;
      holds.set(repoKey, new Promise<void>((resolve) => (release = resolve)));
      return release;
    },
    /** Where `onFocusLost` lands focus. */
    landFocusOn(el: HTMLElement): void {
      landing = el;
    },
    /** Another app dialog, which the setup dialog must not open over. */
    otherDialog: {
      open(): void {
        blocking = true;
      },
      close(): void {
        blocking = false;
        for (const cb of [...closedListeners]) cb();
      },
      /** Closes the open dialog with another opening in its place, so a close is signalled while one stays open. */
      replace(): void {
        for (const cb of [...closedListeners]) cb();
      },
    },
  };
}
