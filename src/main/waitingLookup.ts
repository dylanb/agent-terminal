import { execFile } from 'node:child_process';
import type { ProcessRow } from './waitingRule';

export interface ProcessTableLookup {
  /** Aborting it abandons the lookup and kills its `ps`. */
  readonly signal: AbortSignal;
}

/** The `ps` argv whose output `parseProcessTable` reads. */
export const PS_ARGS: readonly string[] = ['-A', '-o', 'pid=,ppid=,pgid=,tpgid=,etime=,ucomm='];

// A busy host's whole table stays far below this; past it the lookup fails, which reads as no commands.
const MAX_TABLE_BYTES = 16 * 1024 * 1024;

function elapsedSeconds(etime: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!match) return null;
  const [, days = '0', hours = '0', minutes, seconds] = match;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

function parseRow(line: string): ProcessRow | null {
  const match = /^\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(\S+)(?: (.*))?$/.exec(line);
  if (!match) return null;
  const [, pid, ppid, pgid, tpgid, etime, program = ''] = match;
  const elapsedS = elapsedSeconds(etime);
  if (elapsedS === null) return null;
  return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), tpgid: Number(tpgid), elapsedS, program: program.trim() };
}

/** The processes in `ps ${PS_ARGS}` output; a line that is not a process row is skipped. */
export function parseProcessTable(psOutput: string): ProcessRow[] {
  return psOutput.split('\n').map(parseRow).filter((row): row is ProcessRow => row !== null);
}

/** The host's processes, as `ps` lists them. */
export function readProcessTable({ signal }: ProcessTableLookup): Promise<ProcessRow[]> {
  return new Promise((resolve, reject) => {
    try {
      execFile('ps', PS_ARGS, { signal, killSignal: 'SIGKILL', maxBuffer: MAX_TABLE_BYTES, encoding: 'utf8' }, (error, stdout) => {
        if (error) reject(error);
        else resolve(parseProcessTable(stdout));
      });
    } catch (error) {
      reject(error);
    }
  });
}
