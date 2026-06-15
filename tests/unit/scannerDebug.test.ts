import { describe, expect, it } from 'vitest';
import { resolveScannerDebugPath } from '../../src/main/scanner';

describe('scanner capture-trace logging gate (DEBUG=1 opt-in)', () => {
  it('is off by default when DEBUG is unset', () => {
    expect(resolveScannerDebugPath({})).toBeUndefined();
  });

  it('turns on with DEBUG=1, defaulting to /tmp/scanner.log', () => {
    expect(resolveScannerDebugPath({ DEBUG: '1' })).toBe('/tmp/scanner.log');
  });

  it('honors a SCANNER_DEBUG path override when DEBUG=1', () => {
    expect(resolveScannerDebugPath({ DEBUG: '1', SCANNER_DEBUG: '/custom/trace.log' })).toBe('/custom/trace.log');
  });

  it('stays off when DEBUG is set to anything other than 1', () => {
    expect(resolveScannerDebugPath({ DEBUG: '0' })).toBeUndefined();
    expect(resolveScannerDebugPath({ DEBUG: 'true' })).toBeUndefined();
  });

  it('never writes during the test suite (VITEST set), even with DEBUG=1', () => {
    expect(resolveScannerDebugPath({ VITEST: '1', DEBUG: '1' })).toBeUndefined();
  });
});
