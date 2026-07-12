// §26.10 cost accounting — recover per-model token totals from Claude Code's session JSONL logs (the same
// data `cache-analyze` reads at ~/.claude/tools/cache-analyze) so the meter can price them. The JSONL layout
// is Claude Code's PRIVATE format; every accessor degrades silently on drift (a malformed line, a missing
// field, an absent dir) and never throws — cost is display-only and must never abort the loop (CLAUDE.md
// best-effort side-effect rule). The pricing that turns these totals into dollars is shared (pricing.ts).

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ModelTokens } from '../shared/pricing';
import { userConfigRootFrom } from './userConfig';

/** One assistant turn recovered from a session log: its billed tokens, the instant it happened, and the
 *  identity Claude Code bills it under. `at` is NaN and `id` is null when the line carries neither. */
interface SessionTurn extends ModelTokens {
  at: number;
  id: string | null;
}

/** Encode a repo path into Claude Code's project-dir name (§26.10): every non-alphanumeric → `-`. */
export function encodeProjectDir(repoPath: string): string {
  return repoPath.replace(/[^A-Za-z0-9]/g, '-');
}

/** The directory the repo's session JSONL logs live in (§26.10). `APP_SESSION_LOG_ROOT` overrides it with an
 *  EXACT directory (the L7 §26.13 test seam, where the fake-agent writes its fixtures); otherwise it hangs off
 *  the same user-config root the installer seeds, so a CLAUDE_CONFIG_DIR redirect moves both together. */
export function sessionLogDir(repoPath: string, env: NodeJS.ProcessEnv, home: string): string | null {
  const override = env.APP_SESSION_LOG_ROOT;
  if (override && override.length > 0) return override;
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

/** Every `*.jsonl` under `dir`, recursively — the main session's per-`/clear` segments at the top level plus
 *  the reviewer-subagent logs under `<session-uuid>/subagents/` (§26). An unreadable directory yields none. */
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
      if (line.trim() === '') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const turn = extractTurn(obj);
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
