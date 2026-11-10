import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { shellQuote } from '../../src/shared/shellQuote';
import { isErrno } from '../../src/main/errno';

const HANG_S = 60;
const POLL_MS = 10;

export interface HangingExecutable {
  readonly path: string;
  readonly binDir: string;
  started(): Promise<number>;
  running(): boolean;
  exited(): Promise<void>;
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

export function writeHangingExecutable(name: string): HangingExecutable {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new RangeError(`executable name must be a plain word; got ${JSON.stringify(name)}`);
  const binDir = mkdtempSync(join(tmpdir(), 'hanging-executable-'));
  const path = join(binDir, name);
  const pidFile = join(binDir, `${name}.pids`);
  writeFileSync(path, `#!/bin/sh\necho $$ >> ${shellQuote(pidFile)}\nexec sleep ${HANG_S}\n`);
  chmodSync(path, 0o755);
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
