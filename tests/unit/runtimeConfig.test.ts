import { describe, expect, it } from 'vitest';
import { resolveRuntimeConfig } from '../../src/main/runtimeConfig';

describe('resolveRuntimeConfig (§15.7 — env-overridable per-agent profile seam, no magic numbers)', () => {
  it('defaults quietMs to 1000 and parses a valid override, falling back on garbage', () => {
    expect(resolveRuntimeConfig({}).quietMs).toBe(1000);
    expect(resolveRuntimeConfig({ APP_QUIET_MS: '250' }).quietMs).toBe(250);
    expect(resolveRuntimeConfig({ APP_QUIET_MS: 'nope' }).quietMs).toBe(1000);
    expect(resolveRuntimeConfig({ APP_QUIET_MS: '-5' }).quietMs).toBe(1000);
  });

  it('defaults the loop turn-completion timeout and parses an override (§26.3/D48)', () => {
    expect(resolveRuntimeConfig({}).turnCompletionTimeoutMs).toBeGreaterThan(0);
    expect(resolveRuntimeConfig({ APP_TURN_TIMEOUT_MS: '4000' }).turnCompletionTimeoutMs).toBe(4000);
    expect(resolveRuntimeConfig({ APP_TURN_TIMEOUT_MS: 'nope' }).turnCompletionTimeoutMs).toBe(
      resolveRuntimeConfig({}).turnCompletionTimeoutMs,
    );
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

    const over = resolveRuntimeConfig({
      APP_DEDUP_RETENTION: '7',
      APP_MAX_COMMAND_SUMMARIES: '11',
      APP_MAX_OPEN_SPANS: '3',
      APP_MAX_EXTRACTED_ROWS: '99',
      APP_REPORT_MIN_CHARS: '42',
      APP_SELF_INJECT_WINDOW_MS: '5000',
      APP_MAX_DONE_TODOS: '8',
    });
    expect(over.dedupRetention).toBe(7);
    expect(over.maxCommandSummaries).toBe(11);
    expect(over.maxOpenSpans).toBe(3);
    expect(over.maxExtractedRows).toBe(99);
    expect(over.reportMinChars).toBe(42);
    expect(over.selfInjectWindowMs).toBe(5000);
    expect(over.maxDoneTodos).toBe(8);

    const garbage = resolveRuntimeConfig({
      APP_DEDUP_RETENTION: 'x',
      APP_MAX_COMMAND_SUMMARIES: '0',
      APP_MAX_OPEN_SPANS: '-1',
      APP_MAX_EXTRACTED_ROWS: '1.5',
      APP_REPORT_MIN_CHARS: 'nope',
      APP_SELF_INJECT_WINDOW_MS: 'bad',
      APP_MAX_DONE_TODOS: 'x',
    });
    expect(garbage.dedupRetention).toBe(def.dedupRetention);
    expect(garbage.maxCommandSummaries).toBe(def.maxCommandSummaries);
    expect(garbage.maxOpenSpans).toBe(def.maxOpenSpans);
    expect(garbage.maxExtractedRows).toBe(def.maxExtractedRows);
    expect(garbage.reportMinChars).toBe(def.reportMinChars);
    expect(garbage.selfInjectWindowMs).toBe(def.selfInjectWindowMs);
    expect(garbage.maxDoneTodos).toBe(def.maxDoneTodos);
  });
});
