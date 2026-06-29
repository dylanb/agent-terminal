import { describe, expect, it } from 'vitest';
import { createMonitorEventStore } from '../../src/main/eventStore';
import type { MonitorCaptureMsg, MonitorEvent } from '../../src/shared/ipc';

/** A fake persistence backing: an in-memory event list standing in for the on-disk file. A "fresh
 *  store over the same backing" models relaunch — the only observable that matters for restore. */
function fakeBacking(seed: MonitorEvent[] = []) {
  let saved: MonitorEvent[] = seed.map((e) => ({ ...e }));
  return {
    persistence: {
      load: () => saved.map((e) => ({ ...e })),
      save: (events: readonly MonitorEvent[]) => {
        saved = events.map((e) => ({ ...e }));
      },
    },
    current: () => saved,
  };
}

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

  it('stamps captures truncated:false and parentId:null (manual selection is top-level, §15.4)', () => {
    const store = createMonitorEventStore({ now: () => new Date(0) });
    const event = store.addCapture(capture);
    expect(event.truncated).toBe(false);
    expect(event.parentId).toBeNull();
  });

  it('addEvent stamps id/capturedAt and preserves a widened semantic event (§15.4)', () => {
    const store = createMonitorEventStore({ now: () => new Date('2026-06-12T10:00:00Z') });
    const event = store.addEvent({
      sessionId: 's1',
      type: 'report',
      source: 'shadow-scan',
      text: 'A long agent report',
      range: null,
      parentId: null,
      truncated: true,
    });
    expect(event.id).toBeTruthy();
    expect(event.capturedAt).toBe('2026-06-12T10:00:00.000Z');
    expect(event.type).toBe('report');
    expect(event.source).toBe('shadow-scan');
    expect(event.text).toBe('A long agent report');
    expect(event.truncated).toBe(true);
    expect(event.sessionId).toBe('s1');
  });

  it('addEvent appends into the same ordered history as captures', () => {
    const store = createMonitorEventStore({ now: () => new Date(0) });
    const cap = store.addCapture({ ...capture, text: 'manual' });
    const sem = store.addEvent({
      sessionId: 's1',
      type: 'command-output',
      source: 'shell-integration',
      text: 'hi',
      range: null,
      parentId: null,
      truncated: false,
    });
    expect(store.list().map((e) => e.id)).toEqual([cap.id, sem.id]);
  });

  it('addEvent carries a finding parentId through to the stored event', () => {
    const store = createMonitorEventStore({ now: () => new Date(0) });
    const report = store.addEvent({
      sessionId: 's1', type: 'report', source: 'shadow-scan',
      text: 'report', range: null, parentId: null, truncated: false,
    });
    const finding = store.addEvent({
      sessionId: 's1', type: 'finding', source: 'shadow-scan',
      text: 'one finding', range: null, parentId: report.id, truncated: false,
    });
    expect(finding.parentId).toBe(report.id);
  });

  it('remove(id) drops the event and cascades to its child findings (§15.6)', () => {
    const store = createMonitorEventStore({ now: () => new Date(0) });
    const report = store.addEvent({
      sessionId: 's1', type: 'report', source: 'shadow-scan',
      text: 'report', range: null, parentId: null, truncated: false,
    });
    store.addEvent({
      sessionId: 's1', type: 'finding', source: 'shadow-scan',
      text: 'f1', range: null, parentId: report.id, truncated: false,
    });
    store.addEvent({
      sessionId: 's1', type: 'finding', source: 'shadow-scan',
      text: 'f2', range: null, parentId: report.id, truncated: false,
    });
    const keep = store.addCapture({ ...capture, text: 'keep me' });
    store.remove(report.id);
    expect(store.list().map((e) => e.id)).toEqual([keep.id]);
  });

  it('remove(id) of a single non-parent event leaves others intact', () => {
    const store = createMonitorEventStore({ now: () => new Date(0) });
    const a = store.addCapture({ ...capture, text: 'a' });
    const b = store.addCapture({ ...capture, text: 'b' });
    store.remove(a.id);
    expect(store.list().map((e) => e.id)).toEqual([b.id]);
  });

  it('clear() empties the history', () => {
    const store = createMonitorEventStore({ now: () => new Date(0) });
    store.addCapture({ ...capture, text: 'a' });
    store.addCapture({ ...capture, text: 'b' });
    store.clear();
    expect(store.list()).toEqual([]);
  });
});

describe('monitor event persistence — restore after any termination', () => {
  it('replays persisted events on construct', () => {
    const seed: MonitorEvent[] = [
      { id: 'e1', sessionId: 's1', type: 'capture', source: 'selection', text: 'prior', range: null, parentId: null, truncated: false, capturedAt: '2026-06-12T10:00:00.000Z' },
    ];
    const backing = fakeBacking(seed);
    const store = createMonitorEventStore({ persistence: backing.persistence });
    expect(store.list().map((e) => e.text)).toEqual(['prior']);
  });

  it('a capture survives into a fresh store over the same backing', () => {
    const backing = fakeBacking();
    const store = createMonitorEventStore({ now: () => new Date(0), persistence: backing.persistence });
    const event = store.addCapture({ ...capture, text: 'captured' });
    const reborn = createMonitorEventStore({ persistence: backing.persistence });
    expect(reborn.list().map((e) => e.id)).toEqual([event.id]);
    expect(reborn.list().map((e) => e.text)).toEqual(['captured']);
  });

  it('addEvent survives into a fresh store over the same backing', () => {
    const backing = fakeBacking();
    const store = createMonitorEventStore({ now: () => new Date(0), persistence: backing.persistence });
    const sem = store.addEvent({
      sessionId: 's1', type: 'report', source: 'shadow-scan',
      text: 'report body', range: null, parentId: null, truncated: false,
    });
    const reborn = createMonitorEventStore({ persistence: backing.persistence });
    expect(reborn.list().map((e) => e.id)).toEqual([sem.id]);
  });

  it('a removal is reflected after relaunch', () => {
    const backing = fakeBacking();
    const store = createMonitorEventStore({ now: () => new Date(0), persistence: backing.persistence });
    const a = store.addCapture({ ...capture, text: 'a' });
    const b = store.addCapture({ ...capture, text: 'b' });
    store.remove(a.id);
    const reborn = createMonitorEventStore({ persistence: backing.persistence });
    expect(reborn.list().map((e) => e.id)).toEqual([b.id]);
  });

  it('clear is reflected after relaunch', () => {
    const backing = fakeBacking();
    const store = createMonitorEventStore({ now: () => new Date(0), persistence: backing.persistence });
    store.addCapture({ ...capture, text: 'a' });
    store.clear();
    const reborn = createMonitorEventStore({ persistence: backing.persistence });
    expect(reborn.list()).toEqual([]);
  });
});
