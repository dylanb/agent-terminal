// Runtime configuration seam (§15.7): env-overridable thresholds, no magic numbers downstream.

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
  // §27.11: how long the §27 cost meter waits before its next sample of the session logs. Off the turn's
  // synchronous path by construction, so this is a freshness/cost trade, never a deadline on anything.
  costSampleMs: 2000,
  // §27.11: how much of a session log the §27 sweep reads before relinquishing the event loop. A fixture
  // that had to exceed a multi-megabyte chunk to exercise the yielding would ship megabytes into the suite.
  sessionLogChunkBytes: 64 * 1024,
} as const;

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
    costSampleMs: posInt(env.APP_COST_SAMPLE_MS, DEFAULTS.costSampleMs),
    sessionLogChunkBytes: posInt(env.APP_SESSION_LOG_CHUNK_BYTES, DEFAULTS.sessionLogChunkBytes),
  };
}
