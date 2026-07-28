// §27.12 — the per-turn done-signal: the turn writes its `turn-done` file (in the caller-supplied loop
// area) as its last action. Read and clear are separate operations; clearing before the signal has been
// acted on would lose the completion of the turn that wrote it.

import { readFileSync, rmSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { TURN_DONE_FILENAME } from '../shared/loopTurn';

function turnDonePath(repoDir: string, subDir: string): string {
  return path.join(repoDir, subDir, TURN_DONE_FILENAME);
}

/** Read the done-signal file's turn key WITHOUT deleting it; null when absent (never throws). The signal
 *  stays latched until `clearTurnDone` (§27.12), so a re-read returns the same key. `subDir` is the loop
 *  area the caller's engine owns. */
export function readTurnDone(repoDir: string, subDir: string): string | null {
  try {
    return readFileSync(turnDonePath(repoDir, subDir), 'utf8').trim();
  } catch {
    return null;
  }
}

/** Delete the done-signal file (best-effort; absent is fine). The host calls this at the next prompt
 *  inject — the single point at which the completed turn's done-signal state is reset (§27.12). Never
 *  throws: `{ force }` covers ENOENT, but this runs on the injection critical path, so any other rmSync
 *  failure (EPERM, a directory at the path, a transient FS error) is swallowed rather than aborting the
 *  inject (CLAUDE.md — a best-effort reset must not fail the path it sits on; matches `readTurnDone`). */
export function clearTurnDone(repoDir: string, subDir: string): void {
  try {
    rmSync(turnDonePath(repoDir, subDir), { force: true });
  } catch {
    /* best-effort reset; a stale file at worst re-detects the same completed turn, itself deduped */
  }
}

/** Watch `<repoDir>/<subDir>/` for the done-signal file, calling `onChange` on each event touching
 *  it. Returns an unsubscribe, or null when the directory can't be watched yet — the caller must not
 *  cache a null so a later directory appearance re-attaches. */
export function watchTurnDone(repoDir: string, onChange: () => void, subDir: string): (() => void) | null {
  let watcher: FSWatcher;
  try {
    watcher = watch(path.join(repoDir, subDir), (_event, filename) => {
      if (filename === null || filename.toString() === TURN_DONE_FILENAME) onChange();
    });
  } catch {
    return null;
  }
  return () => watcher.close();
}
