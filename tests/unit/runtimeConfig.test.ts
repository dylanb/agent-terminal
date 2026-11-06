import { describe, expect, it } from 'vitest';
import { resolveRuntimeConfig } from '../../src/main/runtimeConfig';

describe('resolveRuntimeConfig (§15.7 — env-overridable per-agent profile seam, no magic numbers)', () => {
  it('defaults quietMs to 1000 and parses a valid override, falling back on garbage', () => {
    expect(resolveRuntimeConfig({}).quietMs).toBe(1000);
    expect(resolveRuntimeConfig({ APP_QUIET_MS: '250' }).quietMs).toBe(250);
    expect(resolveRuntimeConfig({ APP_QUIET_MS: 'nope' }).quietMs).toBe(1000);
    expect(resolveRuntimeConfig({ APP_QUIET_MS: '-5' }).quietMs).toBe(1000);
  });

  it('defaults the loop stall watchdog to thirty minutes and parses an override (§27.12/D48)', () => {
    expect(resolveRuntimeConfig({}).stallTimeoutMs).toBe(1_800_000);
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

  it('defaults the shell quit grace to 2000ms and parses a valid override, falling back on garbage', () => {
    expect(resolveRuntimeConfig({}).shellQuitGraceMs).toBe(2000);
    expect(resolveRuntimeConfig({ APP_SHELL_QUIT_GRACE_MS: '600000' }).shellQuitGraceMs).toBe(600_000);
    expect(resolveRuntimeConfig({ APP_SHELL_QUIT_GRACE_MS: 'nope' }).shellQuitGraceMs).toBe(2000);
  });

  it('defaults the controller branch re-read to five minutes and parses a valid override, falling back on garbage', () => {
    expect(resolveRuntimeConfig({}).branchRefreshMs).toBe(300_000);
    expect(resolveRuntimeConfig({ APP_BRANCH_REFRESH_MS: '1000' }).branchRefreshMs).toBe(1000);
    expect(resolveRuntimeConfig({ APP_BRANCH_REFRESH_MS: 'nope' }).branchRefreshMs).toBe(300_000);
    expect(resolveRuntimeConfig({ APP_BRANCH_REFRESH_MS: '0' }).branchRefreshMs).toBe(300_000);
  });

  // §27.9.1 N9b.5(e), #137 AC14 — the engine's gate-decision bound.
  it('defaults the auto-gate decision bound to 300 000 ms and parses an override', () => {
    expect(resolveRuntimeConfig({}).autoGateDecisionMs).toBe(300_000);
    expect(resolveRuntimeConfig({ APP_AUTO_GATE_DECISION_MS: '1500' }).autoGateDecisionMs).toBe(1500);
  });

  it.each(['NaN', 'Infinity', '-Infinity', '0', '-5', 'abc', '', '  '])('falls back to the default bound on the non-finite or non-positive value %j', (raw) => {
    expect(resolveRuntimeConfig({ APP_AUTO_GATE_DECISION_MS: raw }).autoGateDecisionMs).toBe(300_000);
  });

  it('rounds a fractional bound up and clamps an oversized one to the timer maximum', () => {
    expect(resolveRuntimeConfig({ APP_AUTO_GATE_DECISION_MS: '1.5' }).autoGateDecisionMs).toBe(2);
    expect(resolveRuntimeConfig({ APP_AUTO_GATE_DECISION_MS: '0.1' }).autoGateDecisionMs).toBe(1);
    expect(resolveRuntimeConfig({ APP_AUTO_GATE_DECISION_MS: '1e12' }).autoGateDecisionMs).toBe(2_147_483_647);
    expect(resolveRuntimeConfig({ APP_AUTO_GATE_DECISION_MS: '2147483648' }).autoGateDecisionMs).toBe(2_147_483_647);
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
