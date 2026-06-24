// Live artifact reload (§20.1): watch the viewer's tree root and fire onChange when a file under it
// changes on disk, so main can re-broadcast over the viewer:onChanged seam and the renderer re-pulls.

import { watch } from 'node:fs';
import path from 'node:path';
import { gitRootOf, IGNORED_DIRS } from './artifactTree';

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

/** Injection seam for the watch backend. `onEvent` receives each event's tree-relative filename —
 *  a Buffer on some platforms, and null where the platform omits it. */
export type ViewerWatchFactory = (
  dir: string,
  onEvent: (filename: string | Buffer | null) => void,
) => { close(): void };

const defaultWatchFactory: ViewerWatchFactory = (dir, onEvent) =>
  watch(dir, { recursive: true }, (_event, filename) => onEvent(filename));

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
