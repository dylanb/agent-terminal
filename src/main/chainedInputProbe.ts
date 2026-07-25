import { accessSync, constants, statSync } from 'node:fs';
import { isErrno } from './errno';
import type { ChainedInputState } from './chainedInput';

export function probeChainedInput(absPath: string): ChainedInputState {
  try {
    if (!statSync(absPath).isFile()) return 'unreadable';
    accessSync(absPath, constants.R_OK);
    return 'produced';
  } catch (e) {
    return isErrno(e, 'ENOENT') ? 'not-produced' : 'unreadable';
  }
}
