// Live artifact reload (§20.1): the viewer reads files on demand and otherwise only re-pulls on a
// cwd change, so an on-disk edit to a displayed artifact goes unseen until the next cd. This watches
// the viewer's tree root and fires onChange so main can re-broadcast over the viewer:onChanged seam,
// mirroring the agent-loop state watcher (agentLoopBridge.ts).

import { watch } from 'node:fs';
import path from 'node:path';
import { gitRootOf, IGNORED_DIRS } from './artifactTree';

function isIgnoredEvent(filename: string | Buffer | null, rootName: string): boolean {
  if (filename === null) return false;
  const rel = filename.toString();
  return rel === rootName || rel.split(path.sep).some((seg) => IGNORED_DIRS.has(seg));
}

/** The directory the viewer tree is rooted at (§20.1): the git top-level for a repo cwd, else the
 *  cwd itself — so the recursive watch covers exactly the files discovery can surface. Resolves the
 *  root through the same `gitRootOf` discovery uses, so the watch root and the tree root cannot drift. */
export function viewerRoot(cwd: string): string {
  return gitRootOf(cwd) ?? path.resolve(cwd);
}

/** A burst of edits (a branch switch, a formatter, a busy $HOME before the first cd) lands as many
 *  events; coalescing to one onChange keeps the renderer from re-walking the tree per file. */
export const VIEWER_WATCH_DEBOUNCE_MS = 100;

/** Starts a recursive watch of `dir`, delivering each event's tree-relative filename to `onEvent`. */
export type ViewerWatchFactory = (
  dir: string,
  onEvent: (filename: string | Buffer | null) => void,
) => { close(): void };

const defaultWatchFactory: ViewerWatchFactory = (dir, onEvent) =>
  watch(dir, { recursive: true }, (_event, filename) => onEvent(filename));

/** Watch `dir` recursively, calling `onChange` (coalesced over `opts.debounceMs`) on file events under
 *  it. Returns an unsubscribe that also cancels a pending fire; if the directory can't be watched (it
 *  does not exist yet) it degrades to a no-op, exactly like the agent-loop watcher, so live reload is
 *  simply absent there. `opts.watch` injects the watch factory (defaults to node's recursive fs.watch).*/
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
