// §26.10 cost accounting — recover per-model token totals from Claude Code's session JSONL logs (the same
// data `cache-analyze` reads at ~/.claude/tools/cache-analyze) so the meter can price them. The JSONL layout
// is Claude Code's PRIVATE format; every accessor degrades silently on drift (a malformed line, a missing
// field, an absent dir) and never throws — cost is display-only and must never abort the loop (CLAUDE.md
// best-effort side-effect rule). The pricing that turns these totals into dollars is shared (pricing.ts).

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { ModelTokens } from '../shared/pricing';

/** Encode a repo path into Claude Code's project-dir name (§26.10): every non-alphanumeric → `-`, matching
 *  the `~/.claude/projects/<encoded>/` layout the session logs live under. */
export function encodeProjectDir(repoPath: string): string {
  return repoPath.replace(/[^A-Za-z0-9]/g, '-');
}

/** The directory the repo's session JSONL logs live in (§26.10). `APP_SESSION_LOG_ROOT` overrides it with an
 *  EXACT directory (the L7 §26.13 test seam, where the fake-agent writes its fixtures); otherwise the
 *  production `~/.claude/projects/<encoded-repo>/`. */
export function sessionLogDir(repoPath: string, env: NodeJS.ProcessEnv, home: string): string {
  const override = env.APP_SESSION_LOG_ROOT;
  if (override && override.length > 0) return override;
  return path.join(home, '.claude', 'projects', encodeProjectDir(repoPath));
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** One assistant event's model + usage, or null when the line is not a priced assistant turn. Claude Code's
 *  format: `message.model` + `message.usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens,
 *  output_tokens}`. Any missing/ill-typed field degrades to zero (an absent usage/model → null → skipped). */
function extractUsage(obj: unknown): ModelTokens | null {
  if (obj === null || typeof obj !== 'object') return null;
  const message = (obj as { message?: unknown }).message;
  if (message === null || typeof message !== 'object') return null;
  const model = (message as { model?: unknown }).model;
  const usage = (message as { usage?: unknown }).usage;
  if (typeof model !== 'string' || usage === null || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  return {
    model,
    input: num(u.input_tokens),
    cacheCreate: num(u.cache_creation_input_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    output: num(u.output_tokens),
  };
}

/** Sum per-model token totals from every `*.jsonl` under `logDir` — the main session's per-`/clear` segments
 *  plus the reviewer-subagent logs (§26.10). Sorted by model for a stable result. Never throws: an absent
 *  dir, unreadable file, or unparseable line is skipped. */
export function readSessionTokens(logDir: string): ModelTokens[] {
  let names: string[];
  try {
    names = readdirSync(logDir);
  } catch {
    return [];
  }
  const byModel = new Map<string, ModelTokens>();
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    let text: string;
    try {
      text = readFileSync(path.join(logDir, name), 'utf8');
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
      const usage = extractUsage(obj);
      if (!usage) continue;
      const cur = byModel.get(usage.model) ?? { model: usage.model, input: 0, cacheCreate: 0, cacheRead: 0, output: 0 };
      cur.input += usage.input;
      cur.cacheCreate += usage.cacheCreate;
      cur.cacheRead += usage.cacheRead;
      cur.output += usage.output;
      byModel.set(usage.model, cur);
    }
  }
  return [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model));
}
