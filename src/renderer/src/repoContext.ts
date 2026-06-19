// The single shared OSC-7 repo provider (§16.3). One owner subscribes to `cwd:changed` and
// seeds the current repo from `currentRepo()` on mount; every consumer (todo list, terminal
// selection capture, artifact viewer) reads the repo key from here instead of re-deriving it.
//
// Why this exists: `cwd:changed` fires ONLY on a key *change*, and the first OSC 7 can predate
// a consumer's subscription, so a consumer that listens only to the broadcast is uninitialised
// in the spawn directory ($HOME) — where the key never changes after startup. The seed pull
// (`currentRepo()`, which main backstops with the spawn cwd) closes that gap. Centralising it
// means a new consumer can't forget the seed (the bug we hit three times).

import type { CwdChangedMsg, MonitorApi, RepoInfo } from '../../shared/ipc';

export interface RepoContext {
  /** Current repo key. Null before the first repo is known: the brief window before the mount
   *  seed resolves, or indefinitely if `currentRepo()` rejects, until a `cwd:changed` arrives. */
  repoKey(): string | null;
  cwd(): string | null;
  /** Subscribe to repo changes. If a repo is already known at subscribe time (the seed or a
   *  cwd:changed already arrived), the callback fires immediately with the current value, so a
   *  late-mounted consumer is never left uninitialised until the next cd. Returns an unsubscribe. */
  onChange(cb: (info: RepoInfo) => void): () => void;
}

export function createRepoContext(monitor: Pick<MonitorApi, 'onCwdChanged' | 'currentRepo'>): RepoContext {
  let current: RepoInfo | null = null;
  const cbs = new Set<(info: RepoInfo) => void>();

  function set(info: RepoInfo): void {
    if (current && info.repoKey === current.repoKey && info.cwd === current.cwd) return;
    current = info;
    for (const cb of cbs) cb(info);
  }

  monitor.onCwdChanged((m: CwdChangedMsg) => set({ cwd: m.cwd, repoKey: m.repoKey }));
  // Seed once on mount. Only apply it if nothing was learned in the meantime, so a live
  // cwd:changed that arrives first is never clobbered by the (possibly stale) seed.
  void monitor
    .currentRepo()
    .then((r) => {
      if (r && current === null) set(r);
    })
    // A rejected invoke (main restart) must not be an unhandled rejection; leave the key null
    // until a cwd:changed arrives.
    .catch(() => {});

  return {
    repoKey: () => current?.repoKey ?? null,
    cwd: () => current?.cwd ?? null,
    onChange(cb) {
      cbs.add(cb);
      if (current) cb(current); // late subscriber gets the current value at once
      return () => cbs.delete(cb);
    },
  };
}
