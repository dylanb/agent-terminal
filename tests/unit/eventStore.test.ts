import { describe, expect, it } from 'vitest';
import { createMonitorEventStore } from '../../src/main/eventStore';
import type { MonitorCaptureMsg } from '../../src/shared/ipc';

const capture: MonitorCaptureMsg = {
  sessionId: 's1',
  text: 'some agent output',
  range: {
    start: { x: 0, y: 10 },
    end: { x: 5, y: 12 },
    baseY: 4,
    bufferType: 'normal',
  },
  source: 'selection',
};

describe('monitor event store (§8.4)', () => {
  it('stamps id and ISO capturedAt onto captures', () => {
    const store = createMonitorEventStore({ now: () => new Date('2026-06-12T10:00:00Z') });
    const event = store.addCapture(capture);
    expect(event.id).toBeTruthy();
    expect(event.capturedAt).toBe('2026-06-12T10:00:00.000Z');
    expect(event.type).toBe('capture');
    expect(event.source).toBe('selection');
    expect(event.text).toBe(capture.text);
    expect(event.range).toEqual(capture.range);
    expect(event.sessionId).toBe('s1');
  });

  it('assigns unique ids', () => {
    const store = createMonitorEventStore({ now: () => new Date(0) });
    const a = store.addCapture(capture);
    const b = store.addCapture(capture);
    expect(a.id).not.toBe(b.id);
  });

  it('replays events in capture order', () => {
    const store = createMonitorEventStore({ now: () => new Date(0) });
    const a = store.addCapture({ ...capture, text: 'first' });
    const b = store.addCapture({ ...capture, text: 'second' });
    expect(store.list().map((e) => e.id)).toEqual([a.id, b.id]);
    expect(store.list().map((e) => e.text)).toEqual(['first', 'second']);
  });
});
