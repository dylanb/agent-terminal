// §26.3/D47a — the robust half of the per-turn done-signal: the turn writes `.agent-loop/turn-done`
// as its last action and the orchestrator reads-and-clears it. Consuming the file (not just reading it)
// guarantees a stale signal from a prior turn cannot satisfy the next turn's wait. The companion line
// half is `turnSentinel.ts`; both feed the same `onDoneSignal`.

import { readFileSync, rmSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { TURN_DONE_FILENAME } from '../shared/loopTurn';

function turnDonePath(repoDir: string): string {
  return path.join(repoDir, '.agent-loop', TURN_DONE_FILENAME);
}

/** Read the done-signal file's turn key and delete it; null when absent (never throws). */
export function readAndClearTurnDone(repoDir: string): string | null {
  const file = turnDonePath(repoDir);
  let body: string;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  rmSync(file, { force: true });
  return body.trim();
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
