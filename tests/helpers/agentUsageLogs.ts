// Claude Code and Codex session-log fixtures in the forms the real logs take (§27.4, §27.16), written where
// the app's log sweep looks: every destination comes from src/main/agentUsage/logRoots.ts. Integration tests write
// with explicit millisecond times; the e2e fake agent (tests/e2e/fakeTools.ts) renders the same records with the
// FAKE_* placeholders and stamps them when it bills.

import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { agentWorkingDir, claudeCodeProjectLogDir, codexSessionsDir } from '../../src/main/agentUsage/logRoots';

/** One billed call in the app's 4 kinds: `input` is uncached input. Every writer also logs a reasoning figure of a
 *  third of `output`, inside the output figure as both agents log it, so a reader that counts reasoning on top of
 *  output fails every test that uses these fixtures. */
export interface BilledTokens {
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
}

/** What an earlier Codex (before 0.145.0) logs: no cache-write figure at all. */
export type TokensWithoutCacheWrite = Omit<BilledTokens, 'cacheWrite'>;

export type CodexForm = 'cache-write' | 'no-cache-write';
export type CodexTokens<F extends CodexForm> = F extends 'cache-write' ? BilledTokens : TokensWithoutCacheWrite;

export const FAKE_AT = '__FAKE_AT__';
export const FAKE_CWD = '__FAKE_CWD__';
export const FAKE_TOTAL = '__FAKE_TOTAL__';

const reasoningOf = (output: number): number => Math.floor(output / 3);
const iso = (at: number): string => new Date(at).toISOString();
/** A record's logged time. Refuses one later than now: an agent logs a call once it has made it, so a log file is
 *  always last modified at or after its records' times, which the sweep's file-time rules rely on. */
const recordTime = (at: number): string => {
  if (at > Date.now()) throw new Error(`a fixture record at ${iso(at)} is later than now; an agent never logs a call before making it`);
  return iso(at);
};

let nextId = 0;
const freshId = (): string => `${process.pid}-${++nextId}`;

// ---- Claude Code ----

export interface ClaudeCodeLine {
  /** One API call: lines that share it are the same billed call. */
  id: string;
  timestamp: string;
  tokens: BilledTokens;
  sessionId: string;
  /** The reviewer subagent that made the call, absent for the main session. */
  agentId?: string;
  cwd: string;
  /** Which of the call's streamed lines this is: each line has its own `uuid`, as in the real logs. */
  block: number;
}

export function claudeCodeUsageLine(line: ClaudeCodeLine): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: line.agentId !== undefined,
    ...(line.agentId === undefined ? {} : { agentId: line.agentId }),
    message: {
      model: 'claude-fixture',
      id: `msg_fixture_${line.id}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'fixture' }],
      stop_reason: null,
      usage: {
        input_tokens: line.tokens.input,
        cache_creation_input_tokens: line.tokens.cacheWrite,
        cache_read_input_tokens: line.tokens.cacheRead,
        output_tokens: line.tokens.output,
        output_tokens_details: { thinking_tokens: reasoningOf(line.tokens.output) },
        cache_creation: { ephemeral_1h_input_tokens: line.tokens.cacheWrite, ephemeral_5m_input_tokens: 0 },
        service_tier: 'standard',
      },
    },
    requestId: `req_fixture_${line.id}`,
    type: 'assistant',
    uuid: `uuid-${line.sessionId}-${line.agentId ?? 'main'}-${line.id}-${line.block}`,
    timestamp: line.timestamp,
    userType: 'external',
    cwd: line.cwd,
    sessionId: line.sessionId,
    version: '2.1.280',
  });
}

/** The file a session's call lands in, relative to the worktree's Claude Code log folder: a reviewer subagent's
 *  calls go to the session's own `subagents/agent-<id>.jsonl`. */
export const claudeCodeSessionFile = (sessionId: string, agentId?: string): string =>
  agentId === undefined ? `${sessionId}.jsonl` : join(sessionId, 'subagents', `agent-${agentId}.jsonl`);

export interface ClaudeCodeCall {
  at: number;
  tokens: BilledTokens;
  /** Reuse a returned id to log the same call again, as a resumed or forked session's file copies it. */
  id?: string;
  /** Default `fixture-session`. */
  session?: string;
  subagent?: string;
  /** The call logged on this many lines, as Claude Code repeats a call's usage on each streamed block. Default 1. */
  lines?: number;
}

export interface ClaudeCodeLogs {
  /** The worktree's Claude Code log folder, named from its real path. */
  dir: string;
  /** Logs one call and returns its id. */
  bill(call: ClaudeCodeCall): string;
}

export function claudeCodeLogs(configRoot: string, worktree: string): ClaudeCodeLogs {
  const cwd = agentWorkingDir(worktree);
  const dir = claudeCodeProjectLogDir(configRoot, cwd);
  return {
    dir,
    bill(call) {
      const timestamp = recordTime(call.at);
      const id = call.id ?? freshId();
      const sessionId = call.session ?? 'fixture-session';
      const file = join(dir, claudeCodeSessionFile(sessionId, call.subagent));
      const lines = Array.from({ length: call.lines ?? 1 }, (_, block) =>
        claudeCodeUsageLine({ id, timestamp, tokens: call.tokens, sessionId, agentId: call.subagent, cwd, block }),
      );
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, lines.map((l) => `${l}\n`).join(''));
      return id;
    },
  };
}

// ---- Codex ----

/** Codex's own usage record: its input figure includes its cache reads and cache writes. */
export type CodexUsage = Record<string, number>;

export function codexUsage(form: CodexForm, tokens: TokensWithoutCacheWrite & { cacheWrite?: number }): CodexUsage {
  if (form === 'no-cache-write' && tokens.cacheWrite !== undefined) throw new Error('an earlier Codex logs no cache writes; leave cacheWrite out');
  const cacheWrite = tokens.cacheWrite ?? 0;
  const input = tokens.input + tokens.cacheRead + cacheWrite;
  return {
    input_tokens: input,
    cached_input_tokens: tokens.cacheRead,
    ...(form === 'cache-write' ? { cache_write_input_tokens: cacheWrite } : {}),
    output_tokens: tokens.output,
    reasoning_output_tokens: reasoningOf(tokens.output),
    total_tokens: input + tokens.output,
  };
}

export const addCodexUsage = (a: CodexUsage, b: CodexUsage): CodexUsage =>
  Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, (a[k] ?? 0) + (b[k] ?? 0)]));

/** `cwd: null` writes a session record with no working directory, which the sweep cannot place. */
export function codexSessionMetaLine(meta: { timestamp: string; id: string; cwd: string | null; form: CodexForm }): string {
  return JSON.stringify({
    timestamp: meta.timestamp,
    type: 'session_meta',
    payload: {
      id: meta.id,
      timestamp: meta.timestamp,
      ...(meta.cwd === null ? {} : { cwd: meta.cwd }),
      originator: 'codex_cli_rs',
      cli_version: meta.form === 'cache-write' ? '0.145.0' : '0.144.0',
    },
  });
}

/** `total` is the file's cumulative usage after this record, `last` this record's own call. */
export function codexTokenCountLine(record: { timestamp: string; total: CodexUsage | typeof FAKE_TOTAL; last: CodexUsage }): string {
  return JSON.stringify({
    timestamp: record.timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: record.total, last_token_usage: record.last, model_context_window: 272000 },
      rate_limits: { primary: { used_percent: 12.5, window_minutes: 300 } },
    },
  });
}

export const codexRolloutFile = (sessionsDir: string, at: number, id: string): string => {
  const stamp = iso(at);
  return join(sessionsDir, stamp.slice(0, 4), stamp.slice(5, 7), stamp.slice(8, 10), `rollout-${stamp.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`);
};

export interface CodexSession<F extends CodexForm> {
  file: string;
  /** Logs one call: the file's cumulative total grows by it. */
  bill(at: number, tokens: CodexTokens<F>): void;
  /** Re-sends the last record unchanged, as Codex does on every rate-limit update. */
  reemit(at: number): void;
}

export interface CodexLogs {
  /** Codex's shared log folder. */
  dir: string;
  /** Starts a rollout file, as Codex does when a session (or a reviewer subagent's thread) starts. Its working
   *  directory defaults to the worktree's real path, as Codex records its physical one; a string records another
   *  worktree's, and `null` none at all. */
  session<F extends CodexForm>(opts: { form: F; at: number; cwd?: string | null }): CodexSession<F>;
}

export function codexLogs(codexHome: string, worktree: string): CodexLogs {
  const dir = codexSessionsDir(codexHome);
  const ownCwd = agentWorkingDir(worktree);
  return {
    dir,
    session(opts) {
      const timestamp = recordTime(opts.at);
      const id = `00000000-0000-4000-8000-${freshId().replace(/\D/g, '').padStart(12, '0').slice(-12)}`;
      const file = codexRolloutFile(dir, opts.at, id);
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${codexSessionMetaLine({ timestamp, id, cwd: opts.cwd === undefined ? ownCwd : opts.cwd, form: opts.form })}\n`);
      let total: CodexUsage = {};
      let last: CodexUsage | null = null;
      return {
        file,
        bill(at, tokens) {
          const timestamp = recordTime(at);
          last = codexUsage(opts.form, tokens);
          total = addCodexUsage(total, last);
          appendFileSync(file, `${codexTokenCountLine({ timestamp, total, last })}\n`);
        },
        reemit(at) {
          if (last === null) throw new Error('nothing to re-send before the first bill');
          appendFileSync(file, `${codexTokenCountLine({ timestamp: recordTime(at), total, last })}\n`);
        },
      };
    },
  };
}

// ---- Logs the app cannot read ----

/** Whether this host can make a log the app cannot read while its times stay readable: root reads through
 *  `chmod 000` (the Podman e2e container runs as root), and a filesystem that reports no creation time turns
 *  every unreadable file into the whole-run case. Gate per-step tests with `it.skipIf(!unreadableLogsProvokable())`. */
export function unreadableLogsProvokable(): boolean {
  return process.getuid?.() !== 0 && statSync(tmpdir()).birthtimeMs > 0;
}

type OnCleanup = (cleanup: () => void) => void;

export interface LogsTempDir {
  dir: string;
  /** Makes a log file inside `dir` unreadable, or a log folder inside it unlistable, until the test ends. */
  makeUnreadable(path: string): void;
}

/** A temp dir removed when the test ends through `onCleanup` (vitest's `onTestFinished`). Those callbacks run last
 *  registered first, so its `makeUnreadable` restores before the removal, which a folder left at mode 000 would
 *  refuse; vitest runs `afterEach` hooks before them, so an `afterEach` removal would come too early. */
export function logsTempDir(prefix: string, onCleanup: OnCleanup): LogsTempDir {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    makeUnreadable(path) {
      const inside = relative(dir, resolve(path));
      if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`${path} is not inside the logs temp dir ${dir}`);
      const mode = statSync(path).mode & 0o777;
      onCleanup(() => {
        if (existsSync(path)) chmodSync(path, mode);
      });
      chmodSync(path, 0o000);
    },
  };
}
