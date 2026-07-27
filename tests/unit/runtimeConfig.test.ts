import { describe, expect, it } from 'vitest';
import { constants } from 'node:buffer';
import { resolveRuntimeConfig } from '../../src/main/runtimeConfig';

describe('resolveRuntimeConfig (§15.7 — env-overridable per-agent profile seam, no magic numbers)', () => {
  it('defaults quietMs to 1000 and parses a valid override, falling back on garbage', () => {
    expect(resolveRuntimeConfig({}).quietMs).toBe(1000);
    expect(resolveRuntimeConfig({ APP_QUIET_MS: '250' }).quietMs).toBe(250);
    expect(resolveRuntimeConfig({ APP_QUIET_MS: 'nope' }).quietMs).toBe(1000);
    expect(resolveRuntimeConfig({ APP_QUIET_MS: '-5' }).quietMs).toBe(1000);
  });

  it('defaults the loop stall watchdog to a long window and parses an override (§26.3/D48)', () => {
    // The stall watchdog is deliberately long (~20 min) and activity-gated: it only fires on a genuinely
    // frozen screen, never as a wall-clock deadline on a slow-but-working turn.
    expect(resolveRuntimeConfig({}).stallTimeoutMs).toBe(1_200_000);
    expect(resolveRuntimeConfig({ APP_TURN_TIMEOUT_MS: '4000' }).stallTimeoutMs).toBe(4000);
    expect(resolveRuntimeConfig({ APP_TURN_TIMEOUT_MS: 'nope' }).stallTimeoutMs).toBe(
      resolveRuntimeConfig({}).stallTimeoutMs,
    );
  });

  it('defaults the startup-exit grace to 1000ms and parses a valid override, falling back on garbage', () => {
    expect(resolveRuntimeConfig({}).startupExitGraceMs).toBe(1000);
    expect(resolveRuntimeConfig({ APP_STARTUP_EXIT_GRACE_MS: '500' }).startupExitGraceMs).toBe(500);
    expect(resolveRuntimeConfig({ APP_STARTUP_EXIT_GRACE_MS: 'nope' }).startupExitGraceMs).toBe(1000);
  });

  it('enables shell integration by default and opts out only on exactly "0"', () => {
    expect(resolveRuntimeConfig({}).shellIntegration).toBe(true);
    expect(resolveRuntimeConfig({ APP_SHELL_INTEGRATION: '0' }).shellIntegration).toBe(false);
    expect(resolveRuntimeConfig({ APP_SHELL_INTEGRATION: '1' }).shellIntegration).toBe(true);
  });

  it('enables the Claude Code adapter unless APP_ADAPTER_CLAUDE_CODE=0', () => {
    expect(resolveRuntimeConfig({}).adapterEnabled('claude-code')).toBe(true);
    expect(resolveRuntimeConfig({ APP_ADAPTER_CLAUDE_CODE: '0' }).adapterEnabled('claude-code')).toBe(
      false,
    );
    // Unknown adapters default to enabled (degrade to generic, never to silence — §15.3).
    expect(resolveRuntimeConfig({}).adapterEnabled('unknown')).toBe(true);
  });

  it('resolves every named cap with a default, an override, and garbage→default', () => {
    const def = resolveRuntimeConfig({});
    expect(def.dedupRetention).toBeGreaterThan(0);
    expect(def.maxCommandSummaries).toBeGreaterThan(0);
    expect(def.maxOpenSpans).toBeGreaterThan(0);
    expect(def.maxExtractedRows).toBeGreaterThan(0);
    expect(def.reportMinChars).toBeGreaterThan(0);
    expect(def.selfInjectWindowMs).toBeGreaterThan(0);
    expect(def.maxDoneTodos).toBeGreaterThan(0);
    expect(def.costSampleMs).toBeGreaterThan(0);
    expect(def.sessionLogChunkBytes).toBeGreaterThan(0);

    const over = resolveRuntimeConfig({
      APP_DEDUP_RETENTION: '7',
      APP_MAX_COMMAND_SUMMARIES: '11',
      APP_MAX_OPEN_SPANS: '3',
      APP_MAX_EXTRACTED_ROWS: '99',
      APP_REPORT_MIN_CHARS: '42',
      APP_SELF_INJECT_WINDOW_MS: '5000',
      APP_MAX_DONE_TODOS: '8',
      APP_COST_SAMPLE_MS: '250',
      APP_SESSION_LOG_CHUNK_BYTES: '4096',
    });
    expect(over.dedupRetention).toBe(7);
    expect(over.maxCommandSummaries).toBe(11);
    expect(over.maxOpenSpans).toBe(3);
    expect(over.maxExtractedRows).toBe(99);
    expect(over.reportMinChars).toBe(42);
    expect(over.selfInjectWindowMs).toBe(5000);
    expect(over.maxDoneTodos).toBe(8);
    expect(over.costSampleMs).toBe(250);
    expect(over.sessionLogChunkBytes).toBe(4096);

    const garbage = resolveRuntimeConfig({
      APP_DEDUP_RETENTION: 'x',
      APP_MAX_COMMAND_SUMMARIES: '0',
      APP_MAX_OPEN_SPANS: '-1',
      APP_MAX_EXTRACTED_ROWS: '1.5',
      APP_REPORT_MIN_CHARS: 'nope',
      APP_SELF_INJECT_WINDOW_MS: 'bad',
      APP_MAX_DONE_TODOS: 'x',
      APP_COST_SAMPLE_MS: '-5',
      APP_SESSION_LOG_CHUNK_BYTES: '0',
    });
    expect(garbage.dedupRetention).toBe(def.dedupRetention);
    expect(garbage.maxCommandSummaries).toBe(def.maxCommandSummaries);
    expect(garbage.maxOpenSpans).toBe(def.maxOpenSpans);
    expect(garbage.maxExtractedRows).toBe(def.maxExtractedRows);
    expect(garbage.reportMinChars).toBe(def.reportMinChars);
    expect(garbage.selfInjectWindowMs).toBe(def.selfInjectWindowMs);
    expect(garbage.maxDoneTodos).toBe(def.maxDoneTodos);
    expect(garbage.costSampleMs).toBe(def.costSampleMs);
    // A chunk size of 0 makes every read return zero bytes, so every log reads as empty and the strip
    // shows a confident $0.00 for a run that spent money — the silent zero §27.11 rejects.
    expect(garbage.sessionLogChunkBytes).toBe(def.sessionLogChunkBytes);
  });

  // The chunk size is the only key that reaches a Buffer allocation. `1e15` is a positive integer, so every
  // field-local check passes it through to a RangeError the sweep's per-file degradation cannot be told
  // apart from an unreadable log — every log then yields nothing and the run prices at a confident $0.00.
  // Out of range clamps to the ceiling rather than to the default: the sweep keeps working either way, and
  // an operator who asked for more gets as much as the process can actually allocate.
  it('caps the session-log chunk size at a size the process can allocate', () => {
    for (const raw of ['1e15', String(Number.MAX_SAFE_INTEGER), String(constants.MAX_LENGTH + 1)]) {
      const capped = resolveRuntimeConfig({ APP_SESSION_LOG_CHUNK_BYTES: raw }).sessionLogChunkBytes;
      expect(capped, raw).toBeGreaterThan(0);
      expect(capped, raw).toBeLessThanOrEqual(constants.MAX_LENGTH);
      expect(() => Buffer.allocUnsafe(capped), raw).not.toThrow();
    }
  });

  it('passes an in-range chunk-size override through unchanged', () => {
    expect(resolveRuntimeConfig({ APP_SESSION_LOG_CHUNK_BYTES: '4096' }).sessionLogChunkBytes).toBe(4096);
  });
});
