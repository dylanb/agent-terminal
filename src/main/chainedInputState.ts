// §27.10 — the fs realization of the engine's `inputState` domain predicate: what the upstream loop left at
// a chained input's confined binding. ONE definition, so the host wiring and the tests classify identically.

import { statSync } from 'node:fs';
import { isErrno } from './errno';
import type { ChainedInputState } from './appWorkTurn';

export function chainedInputState(absPath: string): ChainedInputState {
  try {
    return statSync(absPath).isFile() ? 'produced' : 'unreadable';
  } catch (e) {
    return isErrno(e, 'ENOENT') ? 'not-produced' : 'unreadable';
  }
}
