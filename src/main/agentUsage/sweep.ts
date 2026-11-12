import { lstat, open, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { AGENT_KINDS, type AgentKind } from '../../shared/agentKind';
import { readDirEntries } from '../dirEntries';
import { isErrno } from '../errno';
import type { BilledCall } from './billedCall';
import { claudeCodeCalls, claudeCodeCopies, type ClaudeCodeCopy } from './claudeCode';
import { codexSessionCwd, codexStateCalls, newCodexFileState, readCodexLines, type CodexFileState } from './codex';
import { fileSpan, type Span } from './fileSpan';
import { agentWorkingDir, claudeCodeProjectLogDir, codexSessionsDir, type AgentWorkingDir } from './logRoots';

/** `null` is a root the app cannot place (a relative override). */
export interface AgentLogRoots {
  claudeConfigRoot: string | null;
  codexHome: string | null;
}

/** Why some or all of a run's counts cannot be known. An unreadable file with a span makes unavailable only the
 *  steps whose windows overlap it; every other problem makes the whole run unavailable. */
export type LogProblem =
  | { problem: 'unreadable file'; span: Span | 'times-unreadable' }
  | { problem: 'unlistable folder' }
  | { problem: 'missing folder'; agent: AgentKind }
  | { problem: 'no logs' }
  | { problem: 'no log since the start'; agent: AgentKind };

export interface AgentUsageSweep {
  calls: BilledCall[];
  problems: LogProblem[];
}

/** Every file under `dir` whose name `wanted` accepts, a reviewer subagent's own file included; `unlistable` when
 *  `dir` or a folder inside it cannot be listed. */
function logFiles(dir: string, wanted: (name: string) => boolean): string[] | 'unlistable' {
  let entries;
  try {
    entries = readDirEntries(dir);
  } catch {
    return 'unlistable';
  }
  const files: string[] = [];
  for (const e of entries) {
    const entry = path.join(dir, e.name);
    if (e.isDirectory) {
      const inner = logFiles(entry, wanted);
      if (inner === 'unlistable') return inner;
      files.push(...inner);
    } else if (wanted(e.name)) {
      files.push(entry);
    }
  }
  return files;
}

/** A log root that is not there is missing; one that is there but cannot be looked at cannot be listed. */
function rootFiles(root: string | null, wanted: (name: string) => boolean): string[] | 'missing' | 'unlistable' {
  if (root === null) return 'missing';
  try {
    statSync(root);
  } catch (e: unknown) {
    return isErrno(e, 'ENOENT') ? 'missing' : 'unlistable';
  }
  return logFiles(root, wanted);
}

/** A file removed since its folder was listed, as opposed to a link left pointing at nothing. */
async function gone(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return false;
  } catch (e: unknown) {
    return isErrno(e, 'ENOENT');
  }
}

/** How far the app has read one log: the bytes read so far, the unfinished last line among them, and what the
 *  finished lines added up to. `foreign` is a Codex rollout another worktree's session wrote. */
interface Cursor {
  dev: number;
  ino: number;
  read: number;
  tail: Buffer;
  claude: ClaudeCodeCopy[];
  codex: CodexFileState | 'foreign';
}

/** Where each log was left at the last sweep, so the next one reads only what was added. Sweeps that share them run
 *  one at a time. */
export interface LogCursors {
  files: Map<string, Cursor>;
  queue: Promise<unknown>;
}

export const createLogCursors = (): LogCursors => ({ files: new Map(), queue: Promise.resolve() });

type LogFile = { cursor: Cursor; tail: string } | { unreadable: Span | 'times-unreadable' };

async function readBytes(file: string, from: number, to: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const out = Buffer.alloc(to - from);
    let done = 0;
    while (done < out.length) {
      const { bytesRead } = await handle.read(out, done, out.length - done, from + done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    return out.subarray(0, done);
  } finally {
    await handle.close();
  }
}

type LogKind = { kind: 'claude-code' } | { kind: 'codex'; workingDir: AgentWorkingDir };

/** Each file last modified at or after `since`, read on from where `cursors` left it, or found unreadable: an
 *  earlier one holds no call in any window. A Codex rollout whose first line names another worktree is never read
 *  further. */
async function readSince(files: string[], since: number, cursors: LogCursors, log: LogKind): Promise<LogFile[]> {
  const read: LogFile[] = [];
  for (const file of files) {
    let info;
    try {
      info = await stat(file);
    } catch {
      if (await gone(file)) continue;
      read.push({ unreadable: 'times-unreadable' });
      continue;
    }
    if (!info.isFile() || info.mtimeMs < since) continue;
    let cursor = cursors.files.get(file);
    if (cursor !== undefined && (cursor.dev !== info.dev || cursor.ino !== info.ino || info.size < cursor.read)) cursor = undefined;
    try {
      if (cursor === undefined) {
        cursor = { dev: info.dev, ino: info.ino, read: 0, tail: Buffer.alloc(0), claude: [], codex: newCodexFileState() };
        if (log.kind === 'codex') {
          const cwd = codexSessionCwd(await firstLine(file));
          if (cwd !== undefined && cwd !== log.workingDir) cursor.codex = 'foreign';
        }
        cursors.files.set(file, cursor);
      }
      if (cursor.codex === 'foreign') continue;
      if (info.size > cursor.read) {
        const bytes = Buffer.concat([cursor.tail, await readBytes(file, cursor.read, info.size)]);
        const end = bytes.lastIndexOf(0x0a) + 1;
        const finished = bytes.subarray(0, end).toString('utf8');
        cursor.tail = Buffer.from(bytes.subarray(end));
        cursor.read = info.size;
        if (log.kind === 'claude-code') cursor.claude.push(...claudeCodeCopies(finished));
        else readCodexLines(cursor.codex, finished);
      }
      read.push({ cursor, tail: cursor.tail.toString('utf8') });
    } catch (e: unknown) {
      cursors.files.delete(file);
      if (isErrno(e, 'ENOENT')) continue;
      read.push({ unreadable: fileSpan({ created: info.birthtimeMs, modified: info.mtimeMs }) });
    }
  }
  return read;
}

interface AgentLogs {
  calls: BilledCall[];
  problems: LogProblem[];
}

const isClaudeCodeLog = (name: string): boolean => name.endsWith('.jsonl');
const isCodexLog = (name: string): boolean => name.startsWith('rollout-') && name.endsWith('.jsonl');

async function claudeCodeUsage(configRoot: string | null, workingDir: AgentWorkingDir, since: number, cursors: LogCursors): Promise<AgentLogs> {
  const files = rootFiles(configRoot === null ? null : claudeCodeProjectLogDir(configRoot, workingDir), isClaudeCodeLog);
  if (files === 'missing') return { calls: [], problems: [{ problem: 'missing folder', agent: 'claude-code' }] };
  if (files === 'unlistable') return { calls: [], problems: [{ problem: 'unlistable folder' }] };
  const logs = await readSince(files, since, cursors, { kind: 'claude-code' });
  const problems = logs.flatMap((f): LogProblem[] => ('unreadable' in f ? [{ problem: 'unreadable file', span: f.unreadable }] : []));
  if (logs.length === 0) problems.push({ problem: 'no log since the start', agent: 'claude-code' });
  return { calls: claudeCodeCalls(logs.flatMap((f) => ('cursor' in f ? [...f.cursor.claude, ...claudeCodeCopies(f.tail)] : []))), problems };
}

/** A file the app cannot read may be this worktree's, so it counts as this worktree's. */
async function codexUsage(codexHome: string | null, workingDir: AgentWorkingDir, since: number, cursors: LogCursors): Promise<AgentLogs> {
  const files = rootFiles(codexHome === null ? null : codexSessionsDir(codexHome), isCodexLog);
  if (files === 'missing') return { calls: [], problems: [{ problem: 'missing folder', agent: 'codex' }] };
  if (files === 'unlistable') return { calls: [], problems: [{ problem: 'unlistable folder' }] };
  const calls: BilledCall[] = [];
  const problems: LogProblem[] = [];
  let own = 0;
  for (const f of await readSince(files, since, cursors, { kind: 'codex', workingDir })) {
    const fileCalls = 'unreadable' in f ? [] : codexFileCalls(f.cursor, f.tail, workingDir);
    if (fileCalls === null) continue;
    own += 1;
    calls.push(...fileCalls);
    if ('unreadable' in f) problems.push({ problem: 'unreadable file', span: f.unreadable });
  }
  if (own === 0) problems.push({ problem: 'no log since the start', agent: 'codex' });
  return { calls, problems };
}

/** A file's calls with its unfinished last line read too, without keeping that line's effect: it may still grow. */
function codexFileCalls(cursor: Cursor, tail: string, workingDir: AgentWorkingDir): BilledCall[] | null {
  if (cursor.codex === 'foreign') return null;
  if (tail === '') return codexStateCalls(cursor.codex, workingDir);
  const state: CodexFileState = { ...cursor.codex, calls: [...cursor.codex.calls] };
  readCodexLines(state, tail);
  return codexStateCalls(state, workingDir);
}

async function firstLine(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const chunks: Buffer[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      const end = chunk.subarray(0, bytesRead).indexOf(0x0a);
      chunks.push(Buffer.from(chunk.subarray(0, end === -1 ? bytesRead : end)));
      if (end !== -1) break;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Whether an agent has any log for the worktree, whatever its times. */
async function hasLogs(agent: AgentKind, roots: AgentLogRoots, workingDir: AgentWorkingDir): Promise<boolean> {
  if (agent === 'claude-code') {
    const files = rootFiles(roots.claudeConfigRoot === null ? null : claudeCodeProjectLogDir(roots.claudeConfigRoot, workingDir), isClaudeCodeLog);
    return Array.isArray(files) && files.length > 0;
  }
  const files = rootFiles(roots.codexHome === null ? null : codexSessionsDir(roots.codexHome), isCodexLog);
  if (!Array.isArray(files)) return false;
  for (const file of files) {
    try {
      if (codexSessionCwd(await firstLine(file)) === workingDir) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** `since` is the run's start, its first window's opening. A worktree that no longer exists has no logs. Sweeps
 *  that pass the same `cursors` read only what each log gained since the last one. */
export function sweepAgentUsage(roots: AgentLogRoots, worktree: string, agents: readonly AgentKind[], since: number, cursors: LogCursors = createLogCursors()): Promise<AgentUsageSweep> {
  const sweep = cursors.queue.then(() => sweepNow(roots, worktree, agents, since, cursors));
  cursors.queue = sweep.catch(() => undefined);
  return sweep;
}

async function sweepNow(roots: AgentLogRoots, worktree: string, agents: readonly AgentKind[], since: number, cursors: LogCursors): Promise<AgentUsageSweep> {
  let workingDir: AgentWorkingDir;
  try {
    workingDir = agentWorkingDir(worktree);
  } catch {
    return { calls: [], problems: [{ problem: 'no logs' }] };
  }
  const calls: BilledCall[] = [];
  const problems: LogProblem[] = [];
  for (const agent of agents) {
    const logs = agent === 'claude-code' ? await claudeCodeUsage(roots.claudeConfigRoot, workingDir, since, cursors) : await codexUsage(roots.codexHome, workingDir, since, cursors);
    calls.push(...logs.calls);
    problems.push(...logs.problems);
  }
  // An agent that ran either has a log since the start or makes the run unavailable itself, so only a run that
  // hosted none needs this check.
  if (agents.length === 0) {
    let any = false;
    for (const agent of AGENT_KINDS) any ||= await hasLogs(agent, roots, workingDir);
    if (!any) problems.push({ problem: 'no logs' });
  }
  return { calls, problems };
}
