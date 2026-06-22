// The single shared OSC-7 repo provider (§16.3): every consumer reads the repo key here instead of
// re-deriving it.
//
// Why a seed pull, not just the broadcast: `cwd:changed` fires ONLY on a key *change*, and the first
// OSC 7 can predate a consumer's subscription — so a broadcast-only consumer stays uninitialised in
// the spawn dir ($HOME), where the key never changes after startup. `currentRepo()` (main backstops
// it with the spawn cwd) closes that gap; centralising it means a new consumer can't forget it.

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
  // Apply the seed only if nothing was learned meanwhile, so a live cwd:changed that arrives first
  // is never clobbered by the (possibly stale) seed.
  void monitor
    .currentRepo()
    .then((r) => {
      if (r && current === null) set(r);
    })
    .catch(() => {}); // a rejected invoke leaves the key null until a cwd:changed arrives, never rejects

  return {
    repoKey: () => current?.repoKey ?? null,
    cwd: () => current?.cwd ?? null,
    onChange(cb) {
      cbs.add(cb);
      if (current) cb(current);
      return () => cbs.delete(cb);
    },
  };
}
