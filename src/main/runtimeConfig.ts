// Runtime configuration seam (§15.7): env-overridable thresholds, no magic numbers downstream.

import { SAMPLE_BACKOFF_FACTOR_MAX } from './appCostMeter';

// TODO(dylan): a per-agent profile table (D10) is the intended future seam to
// replace these env lookups without touching call sites.

const DEFAULTS = {
  quietMs: 1000,
  dedupRetention: 200,
  maxCommandSummaries: 200,
  maxOpenSpans: 64,
  maxExtractedRows: 2000,
  reportMinChars: 120, // §15.3
  // §16.5: must exceed the active→quiet gap of the agent's reply, or the reply gets suppressed too.
  selfInjectWindowMs: 30_000,
  maxDoneTodos: 50, // §16.4
  // §26.3/D48: how long a turn's screen may stay frozen (no visible-content change) before the run stalls
  // into a recoverable error. Deliberately long (~20 min) and activity-gated — NOT a wall-clock deadline
  // on a working turn, which resets it via §8.3 activity. Env keeps the historical APP_TURN_TIMEOUT_MS name.
  stallTimeoutMs: 1_200_000,
  // §5: a shell that exits within this window of spawn is a startup failure — keep the window open
  // for the diagnostic rather than terminating the app.
  startupExitGraceMs: 1000,
  // §27.11
  costSampleMs: 2000,
  // §27.11
  sessionLogChunkBytes: 64 * 1024,
} as const;

/** Ceiling on `sessionLogChunkBytes`: every field-local check passes a value the `Buffer` allocator then
 *  refuses. */
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
/** Ceiling on `costSampleMs`: the meter multiplies it by `SAMPLE_BACKOFF_FACTOR_MAX` and hands the product
 *  to a timer, which fires in 1 ms rather than raising once the product leaves the 32-bit signed range. */
const MAX_SAMPLE_DELAY_MS = Math.floor((2 ** 31 - 1) / SAMPLE_BACKOFF_FACTOR_MAX);

export interface RuntimeConfig {
  quietMs: number;
  shellIntegration: boolean;
  adapterEnabled(id: string): boolean;
  dedupRetention: number;
  maxCommandSummaries: number;
  maxOpenSpans: number;
  maxExtractedRows: number;
  reportMinChars: number;
  selfInjectWindowMs: number;
  maxDoneTodos: number;
  stallTimeoutMs: number;
  startupExitGraceMs: number;
  costSampleMs: number;
  sessionLogChunkBytes: number;
}

/** Parse a positive integer env value; fall back on unset/garbage/non-positive (§15.7). */
function posInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** `posInt` for a key whose value reaches an allocation: an above-range value is clamped to `max` rather
 *  than dropped to the default, so an operator who asked for more gets as much as the process can give. */
function posIntCapped(raw: string | undefined, fallback: number, max: number): number {
  return Math.min(posInt(raw, fallback), max);
}

export function resolveRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  return {
    quietMs: posInt(env.APP_QUIET_MS, DEFAULTS.quietMs),
    shellIntegration: env.APP_SHELL_INTEGRATION !== '0',
    adapterEnabled: (id) => (id === 'claude-code' ? env.APP_ADAPTER_CLAUDE_CODE !== '0' : true),
    dedupRetention: posInt(env.APP_DEDUP_RETENTION, DEFAULTS.dedupRetention),
    maxCommandSummaries: posInt(env.APP_MAX_COMMAND_SUMMARIES, DEFAULTS.maxCommandSummaries),
    maxOpenSpans: posInt(env.APP_MAX_OPEN_SPANS, DEFAULTS.maxOpenSpans),
    maxExtractedRows: posInt(env.APP_MAX_EXTRACTED_ROWS, DEFAULTS.maxExtractedRows),
    reportMinChars: posInt(env.APP_REPORT_MIN_CHARS, DEFAULTS.reportMinChars),
    selfInjectWindowMs: posInt(env.APP_SELF_INJECT_WINDOW_MS, DEFAULTS.selfInjectWindowMs),
    maxDoneTodos: posInt(env.APP_MAX_DONE_TODOS, DEFAULTS.maxDoneTodos),
    stallTimeoutMs: posInt(env.APP_TURN_TIMEOUT_MS, DEFAULTS.stallTimeoutMs),
    startupExitGraceMs: posInt(env.APP_STARTUP_EXIT_GRACE_MS, DEFAULTS.startupExitGraceMs),
    costSampleMs: posIntCapped(env.APP_COST_SAMPLE_MS, DEFAULTS.costSampleMs, MAX_SAMPLE_DELAY_MS),
    sessionLogChunkBytes: posIntCapped(env.APP_SESSION_LOG_CHUNK_BYTES, DEFAULTS.sessionLogChunkBytes, MAX_CHUNK_BYTES),
  };
}
