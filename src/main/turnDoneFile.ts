// §26.3/D47a — the robust half of the per-turn done-signal: the turn writes `.agent-loop/turn-done`
// as its last action. Read and clear are SEPARATE (§26.3/D46 latch): the read drives completion, but the
// file is NOT consumed until the done-signal has been acted on — the host clears it only at the next
// prompt inject (after /clear fired + the agent re-quiesced), which is also where the sentinel is re-armed.
// A stale file can't satisfy a different turn because the host fires onDoneSignal only when the read key
// matches the active turn. The companion line half is `turnSentinel.ts`; both feed the same `onDoneSignal`.

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
