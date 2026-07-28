// The session-JSONL layout is Claude Code's PRIVATE format — an external dependency the app does not
// control (§27.11).

import { createHash } from 'node:crypto';
import { addTokens, sortedTotals, type ModelTokens } from '../shared/pricing';
import { boundExternalText } from '../shared/audit';

/** Ceiling on one turn's count for any single token category. Far below where the product with the table's
 *  largest per-token price could leave the finite range `CostResult.usd` promises. */
const MAX_TURN_TOKENS = 1e12;

/** Longest composite `[message.id, requestId]` a run retains whole. Bounding it by digest rather than by
 *  rejection keeps both properties the key needs: a replayed turn still collapses, and two turns the log
 *  identified differently stay apart however long those identities were (CWE-770). */
export const MAX_IDENTITY_CHARS = 200;

/** How many distinct models one run accumulates under their own ids. The key space is Claude Code's private
 *  log content (CWE-770). The bound EVICTS into `OVERFLOW_MODEL` rather than refusing, so nothing ever stops
 *  being counted. */
export const MAX_BANKED_MODELS = 256;

/** Where a turn goes when the run is already holding `MAX_BANKED_MODELS` other ids. Absent from `PRICING`
 *  by construction — no model id contains a space — so its dollars surface as `unknown` rather than
 *  vanishing into a figure that has quietly stopped rising (CWE-682/CWE-755). */
export const OVERFLOW_MODEL = 'models past the run bound';

/** How many billing identities a run remembers. Claude Code writes one record per content block of an
 *  assistant message and repeats that message's whole `usage` on each, so a streamed read still meets one
 *  billed turn several times over; measured across this repo's 916 logs the widest such run spans 13
 *  records and the largest single log holds 1,479 distinct identities. The window EVICTS rather than
 *  refusing, so nothing ever stops being counted (CWE-770). */
export const MAX_RECENT_IDENTITIES = 4096;

/** One assistant turn recovered from a session log: its billed tokens, the instant it happened, and the
 *  identity Claude Code bills it under. `at` is NaN and `id` is null when the line carries neither. */
export interface SessionTurn extends ModelTokens {
  at: number;
  id: string | null;
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
 *  and the `message.id`/`requestId` pair the turn is billed under. A missing or ill-typed field degrades (an
 *  absent usage/model → null → skipped; an absent identity → uncollapsible; an absent timestamp → NaN; an
 *  ill-typed count → 0). BOTH engines parse every line through this, so an admission rule added here moves
 *  §26's numbers (AC 10); every §27 one lives on `createRunTotals`'s fold instead. */
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

export function parseTurnLine(line: string): SessionTurn | null {
  if (line.trim() === '') return null;
  try {
    return extractTurn(JSON.parse(line));
  } catch {
    return null;
  }
}

function clampTokens(v: number): number {
  return Math.min(Math.max(v, 0), MAX_TURN_TOKENS);
}

function identityKey(id: string): string {
  return id.length <= MAX_IDENTITY_CHARS ? id : createHash('sha256').update(id).digest('base64');
}

export interface RunTotals {
  /** Fold one log line into the run's totals. A line that is not a priced turn, that falls outside the
   *  run's window, or that repeats a billing identity still remembered changes nothing. */
  fold(line: string): void;
  /** The run's per-model totals, in a stable order. */
  totals(): ModelTokens[];
}

/** The run's per-model totals, folded from the lines of its session logs (§27.11). `since` bounds the run's
 *  window below — the flow's recorded start, so the figure is THIS run's cost and not the repo's lifetime
 *  spend, whose sessions share the same project dir. A turn with no usable instant is excluded in BOTH
 *  directions: a dollar that can be placed in no interval of the window could never be accounted for by the
 *  run's parts. Every §27 admission rule lives here rather than in the decoder both engines share (AC 10). */
export function createRunTotals(since?: number): RunTotals {
  const byModel = new Map<string, ModelTokens>();
  const recent = new Set<string>();

  return {
    fold(line: string): void {
      const turn = parseTurnLine(line);
      if (turn === null || !Number.isFinite(turn.at)) return;
      if (since !== undefined && turn.at < since) return;
      if (turn.id !== null) {
        const key = identityKey(turn.id);
        if (recent.has(key)) return;
        recent.add(key);
        if (recent.size > MAX_RECENT_IDENTITIES) recent.delete(recent.values().next().value as string);
      }
      const named = boundExternalText(turn.model);
      const model = !byModel.has(named) && byModel.size >= MAX_BANKED_MODELS ? OVERFLOW_MODEL : named;
      addTokens(byModel, {
        model,
        input: clampTokens(turn.input),
        cacheCreate: clampTokens(turn.cacheCreate),
        cacheRead: clampTokens(turn.cacheRead),
        output: clampTokens(turn.output),
      });
    },

    totals: () => sortedTotals(byModel),
  };
}
