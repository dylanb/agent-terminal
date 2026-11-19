import { errMsg } from './errno';
import { isRecord } from './yamlRecord';
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { MCP_LAUNCHER_NAME } from '../shared/mcp';
import type { McpTmux } from '../shared/mcpBridge';
import { runTmux } from './mcpTmuxCommand';
import { terminalRecipient, type TerminalRecipient } from './mcpTerminalRoute';

export interface ProcessEntry {
  ppid: number;
  args: string;
}

// Claude Code may interpose its hook shell and a launcher that the shell did not exec.
const MAX_LAUNCH_HOPS = 2;

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

const failures = new Map<string, Set<string>>();

function reportFailure(key: string, error: unknown): void {
  const reason = errMsg(error);
  const reported = failures.get(key) ?? new Set<string>();
  failures.set(key, reported);
  if (reported.has(reason)) return;
  reported.add(reason);
  console.error(`MCP ${key} could not be observed: ${reason}`);
}

const PS_TIMEOUT_MS = 1000;

export function readProcessEntry(pid: number): ProcessEntry | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const key = `process ${pid}`;
  try {
    const line = execFileSync('ps', ['-o', 'ppid=', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8', timeout: PS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    const match = /^\s*(\d+)\s+(.*)$/s.exec(line.trimEnd());
    if (!match) throw new Error('The process table returned malformed process data.');
    failures.delete(key);
    return { ppid: Number(match[1]), args: match[2] };
  } catch (error) {
    if (isRecord(error) && error.status === 1 && error.stdout === '' && error.stderr === '') failures.delete(key);
    else reportFailure(key, error);
    return null;
  }
}

export function sessionRecipient(pid: number, shellPid: number, tmux?: McpTmux): TerminalRecipient | null {
  if (![pid, shellPid].every(id => Number.isSafeInteger(id) && id > 1)) return null;
  const key = `recipient ${JSON.stringify([pid, shellPid, tmux?.socket, tmux?.searchPath])}`;
  try {
    const options: ExecFileSyncOptionsWithStringEncoding = { encoding: 'utf8', timeout: PS_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] };
    const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,stat=,pgid=,tpgid=,tty='], options);
    const clients = tmux === undefined ? '' : runTmux(tmux, [
      'list-clients', '-F', '#{client_pid} #{pane_pid} #{pane_in_mode} #{client_readonly} #{client_key_table} #{synchronize-panes} #{pane_id}',
    ]);
    const recipient = terminalRecipient(processes, pid, shellPid, clients);
    failures.delete(key);
    return recipient;
  } catch (error) {
    reportFailure(key, error);
    return null;
  }
}
