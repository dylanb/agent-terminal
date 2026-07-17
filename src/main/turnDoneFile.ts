// §26.3/D47a, §26.3/D46 — the per-turn done-signal: the turn writes `.agent-loop/turn-done` as its last
// action. Read and clear are separate operations; clearing before the signal has been acted on would lose
// the completion of the turn that wrote it.

import { readFileSync, rmSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { TURN_DONE_FILENAME } from '../shared/loopTurn';

/** The §26 engine's done-file subdir. The §27 engine (§27.15) passes its own area
 *  (`.agent-terminal/loop`) so both engines share one watcher/reader, directory-parameterized (the
 *  ticket's authorized leaf-primitive lift) rather than a second copy. Default keeps §26 unchanged. */
export const AGENT_LOOP_TURN_DONE_SUBDIR = '.agent-loop';

function turnDonePath(repoDir: string, subDir: string): string {
  return path.join(repoDir, subDir, TURN_DONE_FILENAME);
}

/** Read the done-signal file's turn key WITHOUT deleting it; null when absent (never throws). The signal
 *  stays latched until `clearTurnDone` (§26.3/D46), so a re-read returns the same key. */
export function readTurnDone(repoDir: string, subDir: string = AGENT_LOOP_TURN_DONE_SUBDIR): string | null {
  try {
    return readFileSync(turnDonePath(repoDir, subDir), 'utf8').trim();
  } catch {
    return null;
  }
}

/** Delete the done-signal file (best-effort; absent is fine). The host calls this at the next prompt
 *  inject — the single point at which the completed turn's done-signal state is reset (§26.3/D46). Never
 *  throws: `{ force }` covers ENOENT, but this runs on the injection critical path, so any other rmSync
 *  failure (EPERM, a directory at the path, a transient FS error) is swallowed rather than aborting the
 *  inject (CLAUDE.md — a best-effort reset must not fail the path it sits on; matches `readTurnDone`). */
export function clearTurnDone(repoDir: string, subDir: string = AGENT_LOOP_TURN_DONE_SUBDIR): void {
  try {
    rmSync(turnDonePath(repoDir, subDir), { force: true });
  } catch {
    /* best-effort reset; a stale file at worst re-detects the same completed turn, itself deduped */
  }
}

/** Watch `<repoDir>/<subDir>/` for the done-signal file, calling `onChange` on each event touching
 *  it. Returns an unsubscribe, or null when the directory can't be watched yet (mirrors
 *  `watchAgentLoopState`: the caller must not cache a null so a later directory appearance re-attaches). */
export function watchTurnDone(repoDir: string, onChange: () => void, subDir: string = AGENT_LOOP_TURN_DONE_SUBDIR): (() => void) | null {
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
