// Runtime configuration seam (§15.7). Every threshold the scanner/tracker would
// otherwise hardcode resolves here, env-overridable like APP_SUBMIT_DELAY_MS — so
// no magic numbers leak downstream.
// TODO(dylan): a per-agent profile table (D10) is the intended future seam to
// replace these env lookups without touching call sites.

const DEFAULTS = {
  quietMs: 1000,
  dedupRetention: 200,
  maxCommandSummaries: 200,
  maxOpenSpans: 64,
  maxExtractedRows: 2000,
  // Minimum report size (chars) a detector needs before emitting a `report`
  // (§15.3): keeps trivial one-liners and short command output below threshold.
  reportMinChars: 120,
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
  };
}
