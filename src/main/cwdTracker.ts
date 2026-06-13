// CWD tracking via OSC 7 (§16.3). The shell-integration script emits an OSC 7
// `file://host/path` sequence on each prompt; this tracker parses it from the
// shadow (mid-parse, like the §15.5 OSC-133 marks) and broadcasts a repo-key
// change ONLY when the resolved key actually changes — so the action window
// swaps todo lists once per `cd` across a repo boundary, not on every prompt.

import { resolveRepoKey as defaultResolveRepoKey } from './repoKey';

export interface CwdInfo {
  cwd: string;
  repoKey: string;
}

export interface CwdTrackerDeps {
  onOsc(ident: number, cb: (data: string) => void): () => void;
  /** Injectable for tests; defaults to the real filesystem walk (§16.3). */
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
    if (cwd === null) return; // unparseable — ignore
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
