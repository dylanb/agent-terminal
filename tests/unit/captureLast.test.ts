import { describe, expect, it } from 'vitest';
import { createMonitorEventStore } from '../../src/main/eventStore';
import { captureLastReport } from '../../src/main/captureLast';
import type { CaptureLastResult } from '../../src/main/scanner';
import type { SelectionRange } from '../../src/shared/ipc';

const RANGE: SelectionRange = { start: { x: 0, y: 0 }, end: { x: 80, y: 0 }, baseY: 0, bufferType: 'normal' };

function fakeScanner(result: CaptureLastResult | null) {
  return { captureLast: () => result };
}

function emission(text: string) {
  return { type: 'report' as const, source: 'heuristic' as const, text, parentId: null, truncated: false, range: RANGE };
}
function finding(text: string) {
  return { type: 'finding' as const, source: 'heuristic' as const, text, parentId: null, truncated: false, range: RANGE };
}

describe('captureLastReport (§21.1 — manual single-slot)', () => {
  it('stores the detected report and its findings, linking findings to the report id', () => {
    const store = createMonitorEventStore();
    const scanner = fakeScanner({ report: emission('the report'), findings: [finding('one'), finding('two')] });

    const events = captureLastReport('s1', store, scanner);

    expect(events.map((e) => e.text)).toEqual(['the report', 'one', 'two']);
    expect(events[0].type).toBe('report');
    expect(events[1].parentId).toBe(events[0].id);
    expect(events[2].parentId).toBe(events[0].id);
    expect(store.list().map((e) => e.text)).toEqual(['the report', 'one', 'two']);
  });

  it('replaces the prior captured report (single-slot) on a second capture', () => {
    const store = createMonitorEventStore();
    captureLastReport('s1', store, fakeScanner({ report: emission('old report'), findings: [finding('old finding')] }));

    captureLastReport('s1', store, fakeScanner({ report: emission('new report'), findings: [finding('new finding')] }));

    expect(store.list().map((e) => e.text)).toEqual(['new report', 'new finding']);
  });

  it('preserves manual captures and command-output (only the report slot is replaced)', () => {
    const store = createMonitorEventStore();
    store.addEvent({ sessionId: 's1', type: 'command-output', source: 'shell-integration', text: 'ls -la', range: RANGE, parentId: null, truncated: false });
    captureLastReport('s1', store, fakeScanner({ report: emission('a report'), findings: [] }));

    captureLastReport('s1', store, fakeScanner({ report: emission('b report'), findings: [] }));

    expect(store.list().map((e) => e.text)).toEqual(['ls -la', 'b report']);
  });

  it('keeps the prior capture and returns nothing when no report is detected now', () => {
    const store = createMonitorEventStore();
    captureLastReport('s1', store, fakeScanner({ report: emission('kept report'), findings: [] }));

    const events = captureLastReport('s1', store, fakeScanner(null));

    expect(events).toEqual([]);
    expect(store.list().map((e) => e.text)).toEqual(['kept report']);
  });
});
