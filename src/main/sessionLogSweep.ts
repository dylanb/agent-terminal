// The session-JSONL layout is Claude Code's PRIVATE format — an external dependency the app does not
// control (§27.11).

import { readFileSync, readdirSync, promises as fsp } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { addTokens, sortedTotals, type ModelTokens } from '../shared/pricing';
import { boundExternalText } from '../shared/audit';
import { readDirEntriesAsync } from './dirEntries';
import { userConfigRootFrom } from './userConfig';

/** Longest `message.id` / `requestId` the §27 sweep will bank a turn under. Longer is REJECTED, not
 *  truncated: a truncated identity could collapse two distinct billed turns and drop the second's dollars. */
const MAX_ID_CHARS = 200;
/** Longest line the sweep will hold or yield. `chunkBytes` bounds the read, not the string a newline-free
 *  log would otherwise accumulate. Well above the longest line the format produces. */
const MAX_LINE_CHARS = 1_000_000;
/** Ceiling on one turn's count for any single token category. Far below where the product with the table's
 *  largest per-token price could leave the finite range `CostResult.usd` promises. */
const MAX_TURN_TOKENS = 1e12;

/** One assistant turn recovered from a session log: its billed tokens, the instant it happened, and the
 *  identity Claude Code bills it under. `at` is NaN and `id` is null when the line carries neither. */
interface SessionTurn extends ModelTokens {
  at: number;
  id: string | null;
}

/** An instant checked finite. The sweep narrows once, at the only place a turn enters the §27 stream, so a
 *  provider that hands back an unplaceable turn fails to type-check rather than being caught downstream. */
export type FiniteInstant = number & { readonly __finiteInstant: unique symbol };

export function finiteInstant(at: number): FiniteInstant | null {
  return Number.isFinite(at) ? (at as FiniteInstant) : null;
}

/** A turn the §27 sweep places and banks. Both fields are structural rather than promised in prose: the
 *  instant is branded finite, so the turn belongs to an interval of the run's window, and the identity is
 *  total, so a caller that banks it cannot double-count a turn it re-reads. */
export interface PricedTurn extends ModelTokens {
  at: FiniteInstant;
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
 *  and the `message.id`/`requestId` pair the turn is billed under. This is a DECODER and nothing else: it
 *  admits what the format carries, degrading a missing or ill-typed field (an absent usage/model → null →
 *  skipped; an absent identity → uncollapsible; an absent timestamp → NaN; an ill-typed count → 0). Both
 *  engines parse every line through it, so a §27 admission rule applied here would move §26's numbers
 *  (AC 10); those live on `openSessionSweep`'s per-turn path instead. */
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
      addTokens(byModel, turn);
    }
  }
  return sortedTotals(byModel);
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
 *  the drains are disjoint. Only a log read through to its end is remembered, so a read that failed is
 *  retried on the next drain instead of becoming a permanent undercount. Every drift the private log
 *  format can produce degrades — an absent root, an unreadable file, an unparseable or over-long line —
 *  but a root that exists and refuses enumeration THROWS, and so does a chunk size that cannot be
 *  allocated, because a caller that read either as empty would price the run at a confident $0.00. */
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
 *  line. A line longer than `MAX_LINE_CHARS` is dropped at every chunk size — whether it spans chunks or
 *  arrives whole inside one — so the peak string this holds is bounded by `chunkBytes + MAX_LINE_CHARS`
 *  however the operator tunes the read. Returns whether the file was read through to its end: `false`
 *  means the caller saw only part of it, or none of it, and must not remember having read it. */
async function* logLines(file: string, buffer: Buffer): AsyncGenerator<string, boolean> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, 'r');
  } catch {
    return false;
  }
  try {
    const decoder = new StringDecoder('utf8');
    let carry = '';
    let dropping = false;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const parts = (carry + decoder.write(buffer.subarray(0, bytesRead))).split('\n');
      carry = parts.pop() ?? '';
      for (const line of parts) {
        if (dropping) dropping = false;
        else if (line.length <= MAX_LINE_CHARS) yield line;
      }
      if (carry.length > MAX_LINE_CHARS) {
        carry = '';
        dropping = true;
      }
    }
    carry += decoder.end();
    if (!dropping && carry !== '' && carry.length <= MAX_LINE_CHARS) yield carry;
    return true;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Every §27 admission rule, in the one place a turn enters the §27 stream: the model id is bounded before
 *  it can key an accumulator or reach the §25 record, each token count is clamped into a priceable range,
 *  and the identity is made TOTAL. An identity the log stamps is kept only while it is short enough to bank;
 *  otherwise — and whenever the log stamps none — it is derived from the turn's own content, which is what
 *  the replay this identity exists to collapse preserves verbatim. Deriving it from where the turn SITS
 *  would be stable across drains of one log and unstable across FILES, which is the axis a resumed or forked
 *  session actually crosses. */
function admit(turn: SessionTurn, at: FiniteInstant): PricedTurn {
  const priced = {
    model: boundExternalText(turn.model),
    input: clampTokens(turn.input),
    cacheCreate: clampTokens(turn.cacheCreate),
    cacheRead: clampTokens(turn.cacheRead),
    output: clampTokens(turn.output),
  };
  const stamped = turn.id !== null && turn.id.length <= MAX_ID_CHARS ? turn.id : null;
  return {
    ...priced,
    at,
    id:
      stamped ??
      JSON.stringify(['derived', at, priced.model, priced.input, priced.cacheCreate, priced.cacheRead, priced.output]),
  };
}

function clampTokens(v: number): number {
  return Math.min(Math.max(v, 0), MAX_TURN_TOKENS);
}

/** Open a sweep over `logDir` for a run window opening at `options.since` (§27.11). Unlike the aggregate
 *  entry point above this yields turns rather than per-model sums, so each one carries the instant a caller
 *  places it by and the identity a caller banks it under. A turn with NO usable instant is excluded in both
 *  directions, since a dollar that can be placed in no interval of the run's window could never be
 *  accounted for by the run's parts. */
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
      const buffer = Buffer.allocUnsafe(options.chunkBytes);
      for await (const file of jsonlFilesAsync(logDir)) {
        const stamp = await stampOf(file);
        if (options.since !== undefined && stamp !== null && stamp.mtimeMs < options.since) continue;
        if (unchanged(file, stamp)) continue;
        let complete = false;
        const lines = logLines(file, buffer);
        try {
          for (;;) {
            const next = await lines.next();
            if (next.done === true) {
              complete = next.value;
              break;
            }
            const turn = parseLine(next.value);
            const at = turn === null ? null : finiteInstant(turn.at);
            if (turn === null || at === null) continue;
            if (options.since !== undefined && at < options.since) continue;
            yield admit(turn, at);
          }
        } finally {
          await lines.return(false);
        }
        if (complete && stamp !== null) read.set(file, stamp);
      }
    },
  };
}
