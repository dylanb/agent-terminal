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
  // §5: a shell that exits within this window of spawn is a startup failure — keep the window open
  // for the diagnostic rather than terminating the app.
  startupExitGraceMs: 1000,
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
  startupExitGraceMs: number;
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
    startupExitGraceMs: posInt(env.APP_STARTUP_EXIT_GRACE_MS, DEFAULTS.startupExitGraceMs),
  };
}
