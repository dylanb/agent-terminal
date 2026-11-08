import { execFileSync } from 'node:child_process';
import { MCP_LAUNCHER_NAME } from '../shared/mcp';

export interface ProcessEntry {
  ppid: number;
  args: string;
}

/** The most processes that can stand between Claude Code and the server or a hook: the shell it runs a hook
 *  command with, and the launcher if that shell did not exec it. */
const MAX_LAUNCH_HOPS = 2;

/** The Claude Code session that started the process whose parent is `parent`: the nearest ancestor that is not one
 *  of the processes running the installed launcher. Null when the process table cannot say. */
export function claudeSessionOf(parent: number, read: (pid: number) => ProcessEntry | null): number | null {
  let pid = parent;
  for (let hop = 0; hop <= MAX_LAUNCH_HOPS; hop++) {
    const entry = read(pid);
    if (entry === null) return null;
    if (!entry.args.includes(MCP_LAUNCHER_NAME)) return pid;
    pid = entry.ppid;
  }
  return null;
}

const PS_TIMEOUT_MS = 1000;

/** Process `pid`'s parent and command line, from the process table; null when it cannot be read. */
export function readProcessEntry(pid: number): ProcessEntry | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const line = execFileSync('ps', ['-o', 'ppid=', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: PS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    const match = /^\s*(\d+)\s+(.*)$/s.exec(line.trimEnd());
    return match ? { ppid: Number(match[1]), args: match[2] } : null;
  } catch {
    return null;
  }
}
