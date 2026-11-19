// §27.16

import { isTokenFigure, type TokenKind } from '../../shared/tokenCounts';
import { isRecord } from '../yamlRecord';
import type { BilledCall } from './billedCall';
import type { AgentWorkingDir } from './logRoots';

/** A `token_count` record's running total for its file. Codex 0.145.0 and later log `cache_write_input_tokens`;
 *  earlier ones log none. `input` includes the cache reads and cache writes. */
export interface CodexTotal {
  input: number;
  cacheRead: number;
  cacheWrite: number | null;
  output: number;
}

function runningTotal(doc: Record<string, unknown>): CodexTotal | null {
  const { payload } = doc;
  if (doc.type !== 'event_msg' || !isRecord(payload) || payload.type !== 'token_count' || !isRecord(payload.info)) return null;
  const usage = payload.info.total_token_usage;
  if (!isRecord(usage)) return null;
  const { input_tokens: input, cached_input_tokens: cacheRead, cache_write_input_tokens: cacheWrite, output_tokens: output } = usage;
  if (!isTokenFigure(input) || !isTokenFigure(cacheRead) || !isTokenFigure(output)) return null;
  if (cacheWrite !== undefined && !isTokenFigure(cacheWrite)) return null;
  return { input, cacheRead, cacheWrite: cacheWrite ?? null, output };
}

/** What the file's total grew by from `before` to `after`, or `null` when it did not grow. */
function growth(before: CodexTotal, after: CodexTotal): Partial<Record<TokenKind, number>> | null {
  const cacheRead = after.cacheRead - before.cacheRead;
  const cacheWrite = after.cacheWrite === null ? null : after.cacheWrite - (before.cacheWrite ?? 0);
  const kinds: Partial<Record<TokenKind, number>> = {
    cacheRead,
    input: after.input - before.input - cacheRead - (cacheWrite ?? 0),
    output: after.output - before.output,
    ...(cacheWrite === null ? {} : { cacheWrite }),
  };
  const figures = Object.values(kinds);
  return figures.some((n) => n < 0) || figures.every((n) => n === 0) ? null : kinds;
}

const NOTHING: CodexTotal = { input: 0, cacheRead: 0, cacheWrite: null, output: 0 };

const parsed = (line: string): Record<string, unknown> | null => {
  try {
    const doc: unknown = JSON.parse(line);
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
};

/** The working directory a session record names: `null` when it names none, `undefined` when the line is not a
 *  session record. */
export function codexSessionCwd(line: string): unknown {
  const doc = parsed(line);
  if (doc?.type !== 'session_meta') return undefined;
  return isRecord(doc.payload) ? (doc.payload.cwd ?? null) : null;
}

/** What a rollout file's lines so far add up to: the working directory its session named, its last running total
 *  and the calls billed so far. */
export interface CodexFileState {
  cwd: unknown;
  previous: CodexTotal;
  calls: BilledCall[];
}

export const newCodexFileState = (): CodexFileState => ({ cwd: undefined, previous: NOTHING, calls: [] });

/** Reads more of a rollout file's lines into `state`. */
export function readCodexLines(state: CodexFileState, text: string): void {
  for (const line of text.split('\n')) {
    if (state.cwd === undefined) {
      state.cwd = codexSessionCwd(line);
      if (state.cwd !== undefined) continue;
    }
    const doc = parsed(line);
    const total = doc === null ? null : runningTotal(doc);
    const at = typeof doc?.timestamp === 'string' ? Date.parse(doc.timestamp) : Number.NaN;
    if (total === null || !Number.isFinite(at)) continue;
    const kinds = growth(state.previous, total);
    state.previous = total;
    if (kinds !== null) state.calls.push({ at, kinds });
  }
}

/** The calls `state` holds for `worktree`, or `null` when the file is not this worktree's: its session ran anywhere
 *  else or names no working directory. */
export const codexStateCalls = (state: CodexFileState, worktree: AgentWorkingDir): BilledCall[] | null =>
  state.cwd === worktree ? state.calls : null;

export function codexCalls(text: string, worktree: AgentWorkingDir): BilledCall[] | null {
  const state = newCodexFileState();
  readCodexLines(state, text);
  return codexStateCalls(state, worktree);
}
