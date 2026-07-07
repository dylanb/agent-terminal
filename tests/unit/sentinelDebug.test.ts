import { describe, expect, it } from 'vitest';
import { resolveSentinelDebugPath } from '../../src/main/turnSentinel';

// §26.3/D47a — opt-in raw-byte capture of the done-signal line scanner, so the operator can see exactly
// how a real (TUI) agent emits the sentinel. Mirrors the scanner trace gate: DEBUG=1 enables it (default
// /tmp/sentinel.log, overridable via SENTINEL_DEBUG), and it is always off under vitest.
describe('resolveSentinelDebugPath (opt-in sentinel trace)', () => {
  it('is off by default (no DEBUG)', () => {
    expect(resolveSentinelDebugPath({})).toBeUndefined();
  });

  it('defaults to /tmp/sentinel.log under DEBUG=1', () => {
    expect(resolveSentinelDebugPath({ DEBUG: '1' })).toBe('/tmp/sentinel.log');
  });

  it('honors a SENTINEL_DEBUG path override under DEBUG=1', () => {
    expect(resolveSentinelDebugPath({ DEBUG: '1', SENTINEL_DEBUG: '/custom/sentinel.log' })).toBe('/custom/sentinel.log');
  });

  it('treats any DEBUG value other than "1" as off', () => {
    expect(resolveSentinelDebugPath({ DEBUG: '0' })).toBeUndefined();
    expect(resolveSentinelDebugPath({ DEBUG: 'true' })).toBeUndefined();
  });

  it('is always off under vitest so the suite never writes the trace file', () => {
    expect(resolveSentinelDebugPath({ VITEST: '1', DEBUG: '1' })).toBeUndefined();
  });
});
