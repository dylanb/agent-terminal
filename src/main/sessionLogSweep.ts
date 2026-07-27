// Claude Code's session JSONL logs: their location, and the two traversals of them the app needs. The
// layout is Claude Code's PRIVATE format; every accessor degrades silently on drift (a malformed line, a
// missing field, an absent dir) and never throws — cost is display-only and must never abort a loop
// (CLAUDE.md best-effort side-effect rule). The pricing that turns tokens into dollars is shared
// (pricing.ts). Engine-neutral: §26.10's aggregate entry point and §27.11's per-turn stream both live here,
// beside the log-root resolver and the project-dir encoder that §27 keeps past the §27.15 N8 sweep.

import { readFileSync, readdirSync, statSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ModelTokens } from '../shared/pricing';
import { userConfigRootFrom } from './userConfig';

/** One assistant turn recovered from a session log: its billed tokens, the instant it happened, and the
 *  identity Claude Code bills it under. `at` is NaN and `id` is null when the line carries neither. */
export interface SessionTurn extends ModelTokens {
  at: number;
  id: string | null;
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
    model: m.model,
    input: num(u.input_tokens),
    cacheCreate: num(u.cache_creation_input_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    output: num(u.output_tokens),
    at: Date.parse(typeof line.timestamp === 'string' ? line.timestamp : ''),
    id: msgId === null || reqId === null ? null : `${msgId}\x00${reqId}`,
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

/** How much of a log is read before the sweep relinquishes the event loop (§27.11 / AC7). Named and
 *  overridable in the same idiom as every other threshold (§15.7): a fixture that had to exceed a hard-coded
 *  multi-megabyte chunk to exercise the yielding would ship megabytes into every test run. */
export const SESSION_LOG_CHUNK_BYTES = 64 * 1024;

export interface SessionTurnStreamOptions {
  /** Epoch ms the run's window opens at; absent sweeps unbounded. */
  since?: number;
  chunkBytes?: number;
}

/** Whether a log can hold a turn inside a window opening at `since`. A file whose last write predates the
 *  floor cannot; appends bump the mtime, so one that existed before the run and grew during it still can.
 *  An unstattable file is opened — absent and unreadable both degrade to "read it and find out" (AC7). */
function writtenSince(file: string, since: number | undefined): boolean {
  if (since === undefined) return true;
  try {
    return statSync(file).mtimeMs >= since;
  } catch {
    return true;
  }
}

/** Yield the file's complete lines, relinquishing the event loop between chunks so no single read of a log
 *  is an uninterruptible block on the main thread (§27.11 / AC7). A trailing partial line is carried into
 *  the next chunk; an unreadable file yields nothing. */
async function* logLines(file: string, chunkBytes: number): AsyncGenerator<string> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch {
    return;
  }
  try {
    const buffer = Buffer.allocUnsafe(chunkBytes);
    let carry = '';
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, chunkBytes, null);
      if (bytesRead === 0) break;
      const parts = (carry + buffer.toString('utf8', 0, bytesRead)).split('\n');
      carry = parts.pop() ?? '';
      for (const line of parts) yield line;
    }
    if (carry !== '') yield carry;
  } catch {
    /* mid-read failure — cost is display-only, so what was read stands and the rest is dropped */
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Every priced turn under `logDir`, in the order the logs are walked, bounded below by `since` and by
 *  nothing above it (§27.11). Unlike the aggregate entry point above this yields turns rather than
 *  per-model sums, so each one carries the instant a caller places it by and the identity a caller banks it
 *  under — and a turn with NO usable instant is excluded in both directions, since a dollar that can be
 *  placed in no interval of the run's window could never be accounted for by the run's parts.
 *
 *  Never throws: a refused root, an absent dir, an unreadable file and an unparseable line all degrade. */
export async function* streamSessionTurns(
  logDir: string | null,
  options: SessionTurnStreamOptions = {},
): AsyncGenerator<SessionTurn> {
  if (logDir === null) return;
  const chunkBytes = options.chunkBytes ?? SESSION_LOG_CHUNK_BYTES;
  for (const file of jsonlFiles(logDir)) {
    if (!writtenSince(file, options.since)) continue;
    for await (const line of logLines(file, chunkBytes)) {
      const turn = parseLine(line);
      if (!turn || !Number.isFinite(turn.at)) continue;
      if (options.since !== undefined && turn.at < options.since) continue;
      yield turn;
    }
  }
}
