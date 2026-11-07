import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { shellQuote } from '../../src/shared/shellQuote';
import { isErrno } from '../../src/main/errno';

// Longer than any lookup bound a test configures, so only the code under test (or `dispose`) ends it early.
const HANG_S = 60;
const POLL_MS = 10;

export interface HangingExecutable {
  /** The executable: run it by this path, or put `binDir` first on PATH and run it by `name`. */
  readonly path: string;
  readonly binDir: string;
  /** Resolves with the pid of its first run once it has started. A test fires the lookup's bound only after this,
   *  so a slow shell start can never let the bound kill it before it is seen. */
  started(): Promise<number>;
  /** Whether any run of it is still in the process table. Throws when it never started, so a check that it is
   *  gone can never pass because the code under test never ran it. */
  running(): boolean;
  /** Resolves once every run of it is gone from the process table, reaped and not just signalled: an aborted
   *  `execFile` settles before its child is reaped. Throws when it never started. */
  exited(): Promise<void>;
  /** Kills every run still running and removes its directory; never throws for one that never started. */
  dispose(): void;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (isErrno(e, 'ESRCH')) return false;
    throw e;
  }
}

/** Writes an executable called `name` that never answers: each run records its pid, then waits without output, as
 *  a stuck `ps` would. */
export function writeHangingExecutable(name: string): HangingExecutable {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new RangeError(`executable name must be a plain word; got ${JSON.stringify(name)}`);
  const binDir = mkdtempSync(join(tmpdir(), 'hanging-executable-'));
  const path = join(binDir, name);
  const pidFile = join(binDir, `${name}.pids`);
  writeFileSync(path, `#!/bin/sh\necho $$ >> ${shellQuote(pidFile)}\nexec sleep ${HANG_S}\n`);
  chmodSync(path, 0o755);
  // One short append per run, so a read sees only whole lines; a partial last line is a run still writing.
  const pids = (): number[] => {
    if (!existsSync(pidFile)) return [];
    const text = readFileSync(pidFile, 'utf8');
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(Number);
  };
  const recorded = (): number[] => {
    const all = pids();
    if (all.length === 0) throw new Error(`${path} never started`);
    return all;
  };
  return {
    path,
    binDir,
    async started() {
      for (let all = pids(); ; all = pids()) {
        if (all.length > 0) return all[0];
        await delay(POLL_MS);
      }
    },
    running() {
      return recorded().some(alive);
    },
    async exited() {
      recorded();
      while (pids().some(alive)) await delay(POLL_MS);
    },
    dispose() {
      try {
        for (const p of pids()) {
          try {
            process.kill(p, 'SIGKILL');
          } catch (e) {
            if (!isErrno(e, 'ESRCH')) throw e;
          }
        }
      } finally {
        rmSync(binDir, { recursive: true, force: true });
      }
    },
  };
}
