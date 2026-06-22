// CWD tracking via OSC 7 (§16.3). The shell emits OSC 7 on each prompt; this broadcasts
// ONLY when the resolved repo key changes, so the action window swaps todo lists once per
// repo-boundary crossing, not on every prompt.

import { resolveRepoKey as defaultResolveRepoKey } from './repoKey';

export interface CwdInfo {
  cwd: string;
  repoKey: string;
}

export interface CwdTrackerDeps {
  onOsc(ident: number, cb: (data: string) => void): () => void;
  /** Defaults to the real filesystem walk (§16.3). */
  resolveRepoKey?: (cwd: string) => string;
}

export interface CwdTracker {
  cwd(): string | null;
  repoKey(): string | null;
  onChange(cb: (info: CwdInfo) => void): () => void;
  dispose(): void;
}

/** OSC 7 payload is `file://HOST/PATH`; return the percent-decoded PATH, or null. */
export function decodeOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data.trim());
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1]; // malformed %-escape: fall back to the raw path
  }
}

export function createCwdTracker(deps: CwdTrackerDeps): CwdTracker {
  const resolve = deps.resolveRepoKey ?? defaultResolveRepoKey;
  let curCwd: string | null = null;
  let curKey: string | null = null;
  const cbs = new Set<(info: CwdInfo) => void>();

  const unsub = deps.onOsc(7, (data) => {
    const cwd = decodeOsc7(data);
    if (cwd === null) return;
    curCwd = cwd;
    const key = resolve(cwd);
    if (key === curKey) return; // §16.3: broadcast only on repo-key change
    curKey = key;
    for (const cb of cbs) cb({ cwd, repoKey: key });
  });

  return {
    cwd: () => curCwd,
    repoKey: () => curKey,
    onChange(cb) {
      cbs.add(cb);
      return () => cbs.delete(cb);
    },
    dispose() {
      unsub();
      cbs.clear();
    },
  };
}
