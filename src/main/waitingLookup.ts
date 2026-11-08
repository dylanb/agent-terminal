import { execFile } from 'node:child_process';
import { PS_ARGS } from './waitingRule';

export interface ProcessTableLookup {
  /** Aborting it abandons the lookup and kills its `ps`. */
  readonly signal: AbortSignal;
  /** The `ps` executable to run. */
  readonly ps?: string;
}

// A busy host's whole table stays far below this; past it the lookup fails, which reads as no commands.
const MAX_TABLE_BYTES = 16 * 1024 * 1024;

/** The process table in the form `waitingInTable` reads. */
export function readProcessTable({ signal, ps = 'ps' }: ProcessTableLookup): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      execFile(ps, PS_ARGS, { signal, killSignal: 'SIGKILL', maxBuffer: MAX_TABLE_BYTES, encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    } catch (error) {
      reject(error);
    }
  });
}
