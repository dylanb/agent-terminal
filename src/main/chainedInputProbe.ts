// §27.10 — the fs realization of the engine's `inputState` domain predicate: what the upstream loop left at
// a chained input's confined binding. ONE definition, so the host wiring and the tests classify identically.

import { accessSync, constants, statSync } from 'node:fs';
import { isErrno } from './errno';
import type { ChainedInputState } from './chainedInput';

export function probeChainedInput(absPath: string): ChainedInputState {
  try {
    if (!statSync(absPath).isFile()) return 'unreadable';
    // stat succeeds on an artifact this process cannot open — the case the tri-state exists for (one written
    // under another uid) — so the prompt would name it as required reading the agent then fails to read.
    accessSync(absPath, constants.R_OK);
    return 'produced';
  } catch (e) {
    return isErrno(e, 'ENOENT') ? 'not-produced' : 'unreadable';
  }
}
