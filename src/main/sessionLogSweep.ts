// Claude Code's session JSONL logs: their location, and the two traversals of them the app needs. The
// layout is Claude Code's PRIVATE format; every accessor degrades on drift (a malformed line, a missing
// field, an absent dir) — cost is display-only and must never abort a loop (CLAUDE.md best-effort
// side-effect rule). The one thing the §27 sweep will not degrade is a root that exists and refuses
// enumeration, which it raises rather than price as $0.00 (CLAUDE.md dirEntries rule). The pricing that
// turns tokens into dollars is shared (pricing.ts). Engine-neutral: §26.10's aggregate entry point and
// §27.11's per-run sweep both live here, beside the log-root resolver and the project-dir encoder that
// §27 keeps past the §27.15 N8 sweep.

import { readFileSync, readdirSync, promises as fsp } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import type { ModelTokens } from '../shared/pricing';
import { boundAuditText } from '../shared/audit';
import { readDirEntriesAsync } from './dirEntries';
import { userConfigRootFrom } from './userConfig';

/** One assistant turn recovered from a session log: its billed tokens, the instant it happened, and the
 *  identity Claude Code bills it under. `at` is NaN and `id` is null when the line carries neither. */
export interface SessionTurn extends ModelTokens {
  at: number;
  id: string | null;
}

/** A turn the §27 sweep places and banks. Both fields the caller depends on are established here rather
 *  than promised in prose: the instant is finite, so the turn belongs to an interval of the run's window,
 *  and the identity is total, so a caller that banks it cannot double-count a turn it re-reads. */
export interface PricedTurn extends ModelTokens {
  at: number;
  id: string;
}

/** Encode a repo path into Claude Code's project-dir name: every non-alphanumeric → `-`. */
export function encodeProjectDir(repoPath: string): string {
  return repoPath.replace(/[^A-Za-z0-9]/g, '-');
}

/** The directory the repo's session JSONL logs live in. `APP_SESSION_LOG_ROOT` overrides it with an EXACT
 *  directory (the test seam, where the fake-agent writes its fixtures); otherwise it hangs off the same
 *  user-config root the installer seeds, so a CLAUDE_CONFIG_DIR redirect moves both together. A RELATIVE
 *  override is refused on BOTH branches: Claude Code is a separate process with its own cwd, so a relative
 *  value has no single meaning and anchoring it at ours reads a directory nobody writes (CWE-829). */
export function sessionLogDir(repoPath: string, env: NodeJS.ProcessEnv, home: string): string | null {
  const override = env.APP_SESSION_LOG_ROOT;
  if (override && override.length > 0) return path.isAbsolute(override) ? override : null;
  const root = userConfigRootFrom(env, home);
  return root === null ? null : path.join(root, 'projects', encodeProjectDir(repoPath));
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** One assistant event's model, usage, billing identity, and instant — or null when the line is not a priced
 *  assistant turn. Claude Code's format: `message.model` + `message.usage.{input_tokens,
 *  cache_creation_input_tokens, cache_read_input_tokens, output_tokens}`, alongside a top-level `timestamp`
 *  and the `message.id`/`requestId` pair the turn is billed under. Any missing/ill-typed field degrades (an
 *  absent usage/model → null → skipped; an absent identity → uncollapsible; an absent timestamp → NaN). */
function extractTurn(obj: unknown): SessionTurn | null {
  if (obj === null || typeof obj !== 'object') return null;
  const line = obj as { message?: unknown; timestamp?: unknown; requestId?: unknown };
  const message = line.message;
  if (message === null || typeof message !== 'object') return null;
  const m = message as { model?: unknown; usage?: unknown; id?: unknown };
  if (typeof m.model !== 'string' || m.usage === null || typeof m.usage !== 'object') return null;
  const u = m.usage as Record<string, unknown>;
  // The billing identity is BOTH message.id and requestId; a turn missing either is only half-identified
  // and stays uncollapsible (null) rather than deduping on the half it has (which would hide real spend).
  const msgId = str(m.id);
  const reqId = str(line.requestId);
  return {
    model: boundAuditText(m.model),
    input: num(u.input_tokens),
    cacheCreate: num(u.cache_creation_input_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    output: num(u.output_tokens),
    at: Date.parse(typeof line.timestamp === 'string' ? line.timestamp : ''),
    id: msgId === null || reqId === null ? null : JSON.stringify([msgId, reqId]),
  };
}

function parseLine(line: string): SessionTurn | null {
  if (line.trim() === '') return null;
  try {
    return extractTurn(JSON.parse(line));
  } catch {
    return null;
  }
}

/** Every `*.jsonl` under `dir`, recursively — the main session's per-`/clear` segments at the top level plus
 *  the reviewer-subagent logs under `<session-uuid>/subagents/`. An unreadable directory yields none. */
function jsonlFiles(dir: string): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...jsonlFiles(full));
    else if (e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/** Sum per-model token totals from the session logs under `logDir` — the main session's per-`/clear` segments
 *  plus the reviewer-subagent logs (§26.10). Sorted by model for a stable result.
 *
 *  `since` (epoch ms) bounds the sweep to turns at or after that instant — the flow's start, so the readout is
 *  THIS run's cost and not the repo's lifetime spend, whose sessions share the same project dir. A turn whose
 *  timestamp is missing or unparseable cannot be placed in the run and is excluded once a bound is given.
 *
 *  A turn is counted ONCE per `message.id`+`requestId`: resuming or forking a session replays the prior turns
 *  verbatim into the new session file, and the API bills them once.
 *
 *  Never throws: a refused root (`null`), an absent dir, an unreadable file, or an unparseable line is
 *  skipped — cost is display-only and must never abort the loop. */
export function readSessionTokens(logDir: string | null, since?: number): ModelTokens[] {
  if (logDir === null) return [];
  const byModel = new Map<string, ModelTokens>();
  const counted = new Set<string>();
  for (const file of jsonlFiles(logDir)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const turn = parseLine(line);
      if (!turn) continue;
      if (since !== undefined && !(turn.at >= since)) continue;
      if (turn.id !== null) {
        if (counted.has(turn.id)) continue;
        counted.add(turn.id);
      }
      const cur = byModel.get(turn.model) ?? { model: turn.model, input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
      cur.input += turn.input;
      cur.cacheCreate += turn.cacheCreate;
      cur.cacheRead += turn.cacheRead;
      cur.output += turn.output;
      byModel.set(turn.model, cur);
    }
  }
  return [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model));
}

export interface SessionSweepOptions {
  /** Epoch ms the run's window opens at; absent sweeps unbounded. */
  since?: number;
  /** How much of a log is read before the sweep relinquishes the event loop (§27.11 / AC7). */
  chunkBytes: number;
}

/** A sweep of ONE run's window over a repo's session logs (§27.11). Each drain yields every priced turn in
 *  the window the sweep has not already yielded from an UNCHANGED log: the first yields the whole window,
 *  and a log that grew is re-yielded whole, so a caller must bank each turn's identity rather than assume
 *  the drains are disjoint. Every drift the private log format can produce degrades — an absent root, an
 *  unreadable file, an unparseable line — but a root that exists and refuses enumeration THROWS, because a
 *  caller that read it as empty would price the run at a confident $0.00. */
export interface SessionSweep {
  drain(): AsyncIterable<PricedTurn>;
}

/** Every `*.jsonl` under `dir`, recursively, without occupying the main thread for the walk (AC7). */
async function* jsonlFilesAsync(dir: string): AsyncGenerator<string> {
  for (const entry of await readDirEntriesAsync(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory) yield* jsonlFilesAsync(full);
    else if (entry.name.endsWith('.jsonl')) yield full;
  }
}

/** What a log looked like last time the sweep read it. Null for a file that will not stat: absent and
 *  unreadable both degrade to "read it and find out", and neither is remembered. */
interface LogStamp {
  mtimeMs: number;
  size: number;
}

async function stampOf(file: string): Promise<LogStamp | null> {
  try {
    const s = await fsp.stat(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/** Yield the file's complete lines, relinquishing the event loop between chunks so no single read of a log
 *  is an uninterruptible block on the main thread (§27.11 / AC7). A chunk boundary is a BYTE boundary, so
 *  the decoder holds an incomplete trailing character across it and `carry` holds an incomplete trailing
 *  line; an unreadable file yields nothing. */
async function* logLines(file: string, chunkBytes: number): AsyncGenerator<string> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch {
    return;
  }
  try {
    const buffer = Buffer.allocUnsafe(chunkBytes);
    const decoder = new StringDecoder('utf8');
    let carry = '';
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, chunkBytes, null);
      if (bytesRead === 0) break;
      const parts = (carry + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
      carry = parts.pop() ?? '';
      for (const line of parts) yield line;
    }
    carry += decoder.end();
    if (carry !== '') yield carry;
  } catch {
    /* mid-read failure — cost is display-only, so what was read stands and the rest is dropped */
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Open a sweep over `logDir` for a run window opening at `options.since` (§27.11). Unlike the aggregate
 *  entry point above this yields turns rather than per-model sums, so each one carries the instant a caller
 *  places it by and the identity a caller banks it under. A turn with NO usable instant is excluded in both
 *  directions, since a dollar that can be placed in no interval of the run's window could never be
 *  accounted for by the run's parts; a turn the log stamps no billing identity on is given one derived from
 *  where it sits, which is stable across drains because the logs are append-only. */
export function openSessionSweep(logDir: string | null, options: SessionSweepOptions): SessionSweep {
  const read = new Map<string, LogStamp>();
  const unchanged = (file: string, stamp: LogStamp | null): boolean => {
    if (stamp === null) return false;
    const last = read.get(file);
    return last !== undefined && last.mtimeMs === stamp.mtimeMs && last.size === stamp.size;
  };
  return {
    async *drain(): AsyncGenerator<PricedTurn> {
      if (logDir === null) return;
      for await (const file of jsonlFilesAsync(logDir)) {
        const stamp = await stampOf(file);
        if (options.since !== undefined && stamp !== null && stamp.mtimeMs < options.since) continue;
        if (unchanged(file, stamp)) continue;
        let ordinal = 0;
        for await (const line of logLines(file, options.chunkBytes)) {
          const turn = parseLine(line);
          if (!turn || !Number.isFinite(turn.at)) continue;
          ordinal += 1;
          if (options.since !== undefined && turn.at < options.since) continue;
          yield { ...turn, id: turn.id ?? JSON.stringify([file, ordinal]) };
        }
        if (stamp !== null) read.set(file, stamp);
      }
    },
  };
}
