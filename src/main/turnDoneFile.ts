// §26.3/D47a, §26.3/D46 — the per-turn done-signal: the turn writes `.agent-loop/turn-done` as its last
// action. Read and clear are separate operations; clearing before the signal has been acted on would lose
// the completion of the turn that wrote it.

import { readFileSync, rmSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { TURN_DONE_FILENAME } from '../shared/loopTurn';

function turnDonePath(repoDir: string): string {
  return path.join(repoDir, '.agent-loop', TURN_DONE_FILENAME);
}

/** Read the done-signal file's turn key WITHOUT deleting it; null when absent (never throws). The signal
 *  stays latched until `clearTurnDone` (§26.3/D46), so a re-read returns the same key. */
export function readTurnDone(repoDir: string): string | null {
  try {
    return readFileSync(turnDonePath(repoDir), 'utf8').trim();
  } catch {
    return null;
  }
}

/** Delete the done-signal file (best-effort; absent is fine). The host calls this at the next prompt
 *  inject — the single point at which the completed turn's done-signal state is reset (§26.3/D46). */
export function clearTurnDone(repoDir: string): void {
  rmSync(turnDonePath(repoDir), { force: true });
}

/** Watch `<repoDir>/.agent-loop/` for the done-signal file, calling `onChange` on each event touching
 *  it. Returns an unsubscribe, or null when the directory can't be watched yet (mirrors
 *  `watchAgentLoopState`: the caller must not cache a null so a later directory appearance re-attaches). */
export function watchTurnDone(repoDir: string, onChange: () => void): (() => void) | null {
  let watcher: FSWatcher;
  try {
    watcher = watch(path.join(repoDir, '.agent-loop'), (_event, filename) => {
      if (filename === null || filename.toString() === TURN_DONE_FILENAME) onChange();
    });
  } catch {
    return null;
  }
  return () => watcher.close();
}
