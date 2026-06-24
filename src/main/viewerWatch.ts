// Live artifact reload (§20.1): the viewer reads files on demand and otherwise only re-pulls on a
// cwd change, so an on-disk edit to a displayed artifact goes unseen until the next cd. This watches
// the viewer's tree root and fires onChange so main can re-broadcast over the viewer:onChanged seam,
// mirroring the agent-loop state watcher (agentLoopBridge.ts).

import { execFileSync } from 'node:child_process';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { IGNORED_DIRS } from './artifactTree';

/** True for a recursive-watch event the viewer must ignore: one under a discovery-ignored dir (.git,
 *  node_modules, …) — `git status`'s own `.git/index` write would otherwise feed a reload loop — or
 *  the spurious self-event macOS emits for the watched root itself (`filename === basename(dir)`),
 *  which carries no real change (genuine edits arrive under their own named events). `filename` is the
 *  tree-relative path; a Buffer on some platforms, null where the platform omits it — null can't be
 *  classified, so it passes through and fires. */
function isIgnoredEvent(filename: string | Buffer | null, rootName: string): boolean {
  if (filename === null) return false;
  const rel = filename.toString();
  return rel === rootName || IGNORED_DIRS.has(rel.split(path.sep)[0]);
}

/** The directory the viewer tree is rooted at (§20.1): the git top-level for a repo cwd, else the
 *  cwd itself — so the recursive watch covers exactly the files discovery can surface. */
export function viewerRoot(cwd: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
    if (out) return path.resolve(out);
  } catch {
    // not a repo (or git unavailable) → the cwd is the tree root
  }
  return path.resolve(cwd);
}

/** A burst of edits (a branch switch, a formatter, a busy $HOME before the first cd) lands as many
 *  events; coalescing to one onChange keeps the renderer from re-walking the tree per file. */
export const VIEWER_WATCH_DEBOUNCE_MS = 100;

/** Watch `dir` recursively, calling `onChange` (coalesced over VIEWER_WATCH_DEBOUNCE_MS) on file
 *  events under it. Returns an unsubscribe that also cancels a pending fire; if the directory can't be
 *  watched — it is missing, or the platform lacks recursive fs.watch (Linux) — it degrades to a no-op,
 *  exactly like the agent-loop watcher, so live reload is simply absent there. */
export function watchViewerTree(
  dir: string,
  onChange: () => void,
  debounceMs = VIEWER_WATCH_DEBOUNCE_MS,
): () => void {
  const rootName = path.basename(path.resolve(dir));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(dir, { recursive: true }, (_event, filename) => {
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
