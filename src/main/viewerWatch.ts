// Live artifact reload (§20.1): watch the viewer's tree root and fire onChange when a file under it
// changes on disk, so main can re-broadcast over the viewer:onChanged seam and the renderer re-pulls.

import { watch, readdirSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { gitRootOf, IGNORED_DIRS } from './artifactTree';

/** App-owned state dirs the viewer watch ALWAYS covers, even though a repo's .gitignore excludes them:
 *  the flow/loop state the app writes lives here and must live-reload. Everything else is governed by the
 *  repo's own .gitignore (below) rather than a hard-coded skip list. */
const ALWAYS_WATCH_DIRS = ['.agent-terminal', '.agent-loop'];

/** Cap on `git ls-files` stdout. A repo whose tracked-file list exceeds this makes execFileSync throw, and
 *  the caller falls back to walking the tree — degraded, not broken. */
const GIT_LS_FILES_MAX_BYTES = 64 * 1024 * 1024;

function isIgnoredEvent(filename: string | Buffer | null, rootName: string): boolean {
  if (filename === null) return false;
  const rel = filename.toString();
  return rel === rootName || rel.split(path.sep).some((seg) => IGNORED_DIRS.has(seg));
}

/** The tree root the watch covers (§20.1): the git top-level for a repo cwd, else the cwd itself,
 *  resolved through the same `gitRootOf` discovery uses so the watch root and the tree root cannot drift. */
export function viewerRoot(cwd: string): string {
  return gitRootOf(cwd) ?? path.resolve(cwd);
}

/** A burst of edits (a branch switch, a formatter, a busy $HOME before the first cd) lands as many
 *  events; coalescing to one onChange keeps the renderer from re-walking the tree per file. */
export const VIEWER_WATCH_DEBOUNCE_MS = 100;

/** Injection seam for the watch backend. `onEvent` receives each event's filename relative to the specific
 *  directory that fired it (the default factory watches many dirs individually, non-recursively), NOT the
 *  viewer root — a Buffer on some platforms, and null where the platform omits it. */
export type ViewerWatchFactory = (
  dir: string,
  onEvent: (filename: string | Buffer | null) => void,
) => { close(): void };

/** The directories the watch covers: `root` plus every descendant that is not (and is not inside) an
 *  IGNORED_DIR. node's recursive `fs.watch` cannot be told to skip a subtree, so it would create an
 *  inotify watch for every `node_modules` folder and exhaust the system limit (ENOSPC) on a repo checkout;
 *  enumerating the non-ignored dirs here and watching each one keeps the watch surface aligned with
 *  discovery (which also skips IGNORED_DIRS at any depth). Never throws — an unreadable dir is left as a
 *  leaf. A symlinked directory is watched as a single bounded leaf but never descended into: a symlinked
 *  ENTRY is already excluded (readdir `isDirectory()` is false for it), and a symlinked ROOT — e.g. a repo
 *  that plants `.agent-loop` as a symlink to a huge tree, which viewerWatchDirs walks as a root — is caught
 *  by the lstat guard, so following it never enumerates the target's subtree and re-exhausts inotify
 *  (ENOSPC, the crash this walk prevents; CWE-59). */
export function watchableDirs(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    out.push(d);
    try {
      if (lstatSync(d).isSymbolicLink()) return;
    } catch {
      return;
    }
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory() && !IGNORED_DIRS.has(e.name)) walk(path.join(d, e.name));
    }
  };
  walk(root);
  return out;
}

/** The directories under `gitRoot` that hold a file the repo's .gitignore does NOT exclude (tracked, or
 *  untracked-but-not-ignored) — every ancestor dir of each such file, derived from ONE `git ls-files` call.
 *  Because git prunes ignored subtrees itself, an ignored dir (node_modules, build/, dist/, coverage/, …
 *  whatever THIS repo ignores) is never enumerated or walked — generalizing the old hard-coded node_modules
 *  skip to the repo's own ignore rules. null when git cannot be consulted (caller falls back). */
function gitNonIgnoredDirs(gitRoot: string): string[] | null {
  let out: string;
  try {
    out = execFileSync('git', ['-C', gitRoot, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      encoding: 'utf8',
      maxBuffer: GIT_LS_FILES_MAX_BYTES,
    });
  } catch {
    return null;
  }
  const dirs = new Set<string>([gitRoot]);
  for (const rel of out.split('\0')) {
    if (!rel) continue;
    let d = path.dirname(rel);
    while (d !== '.' && d !== path.dirname(d)) {
      dirs.add(path.join(gitRoot, d));
      d = path.dirname(d);
    }
  }
  return [...dirs];
}

/** The directories the live-reload watch covers for a viewer root (`viewerRoot(cwd)` — the git top-level,
 *  or the cwd outside a repo), always PLUS the app state dirs (§20.1). In a git repo: every dir the repo's
 *  .gitignore does not exclude (so node_modules/build/dist/… are skipped per THIS repo's rules, not a
 *  hard-coded list) union the always-watch app dirs. OUTSIDE a repo: ONLY the app dirs under the cwd — never
 *  the cwd itself, because a normal directory like $HOME would recursively watch the user's entire
 *  filesystem and exhaust the inotify limit (ENOSPC, the reported crash). A missing dir is a path the watch
 *  factory simply skips. */
export function viewerWatchDirs(root: string): string[] {
  const appDirs = ALWAYS_WATCH_DIRS.flatMap((d) => watchableDirs(path.join(root, d)));
  const gitRoot = gitRootOf(root);
  if (gitRoot === null) return appDirs;
  // git-failure fallback: the hard-coded IGNORED_DIRS walk still excludes node_modules/.git.
  const nonIgnored = gitNonIgnoredDirs(gitRoot) ?? watchableDirs(gitRoot);
  return [...new Set([...nonIgnored, ...appDirs])];
}

// Watch each covered directory individually (never node_modules/.git — the ENOSPC source; never the whole
// cwd outside a repo). Each watcher gets an `error` handler: an fs.watch error is delivered as an async
// `error` EVENT, which with no listener becomes an uncaught exception that crashes the whole app — and live
// artifact reload (§20.1) is a cosmetic convenience that must never abort the process (CLAUDE.md). A per-dir
// failure degrades to one fewer watched dir; the disposer closes them all.
const defaultWatchFactory: ViewerWatchFactory = (dir, onEvent) => {
  const watchers = viewerWatchDirs(dir)
    .map((d) => {
      try {
        const w = watch(d, (_event, filename) => onEvent(filename));
        w.on('error', () => {});
        return w;
      } catch {
        return null;
      }
    })
    .filter((w): w is ReturnType<typeof watch> => w !== null);
  return {
    close() {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* already closed / removed */
        }
      }
    },
  };
};

/** Watch `dir` recursively, coalescing events over `opts.debounceMs` into one `onChange` (§20.1).
 *  `opts.watch` injects the watch backend (defaults to node's recursive fs.watch); the returned
 *  disposer stops the watch. A directory that cannot be watched yields an inert disposer. */
export function watchViewerTree(
  dir: string,
  onChange: () => void,
  opts: { debounceMs?: number; watch?: ViewerWatchFactory } = {},
): () => void {
  const debounceMs = opts.debounceMs ?? VIEWER_WATCH_DEBOUNCE_MS;
  const makeWatcher = opts.watch ?? defaultWatchFactory;
  const rootName = path.basename(path.resolve(dir));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };
  let watcher: { close(): void } | undefined;
  try {
    watcher = makeWatcher(dir, (filename) => {
      if (!isIgnoredEvent(filename, rootName)) schedule();
    });
  } catch {
    return () => {};
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
