// In-memory monitor event list (§8.4): stamps captures and replays them to a
// (re)loaded monitor pane. No persistence this version.

import { randomUUID } from 'node:crypto';
import type { MonitorCaptureMsg, MonitorEvent } from '../shared/ipc';

/** A semantic/command event minus the main-stamped id/capturedAt (§15.4). */
export type NewMonitorEvent = Omit<MonitorEvent, 'id' | 'capturedAt'>;

export interface MonitorEventStore {
  addCapture(msg: MonitorCaptureMsg): MonitorEvent;
  /** Append a pre-typed semantic/command event; main stamps id/capturedAt (§15.4). */
  addEvent(event: NewMonitorEvent): MonitorEvent;
  /** Drop an event and cascade to its child findings (§15.6 / v2.6). */
  remove(id: string): void;
  /** Drop every event (Dismiss-all, §15.6 / v2.6). */
  clear(): void;
  list(): readonly MonitorEvent[];
}

export function createMonitorEventStore(opts: { now?: () => Date } = {}): MonitorEventStore {
  const now = opts.now ?? (() => new Date());
  const events: MonitorEvent[] = [];

  function append(event: MonitorEvent): MonitorEvent {
    events.push(event);
    return event;
  }

  return {
    addCapture(msg) {
      return append({
        id: randomUUID(),
        sessionId: msg.sessionId,
        type: 'capture',
        source: msg.source,
        text: msg.text,
        range: msg.range,
        parentId: null,
        truncated: false,
        capturedAt: now().toISOString(),
      });
    },
    addEvent(event) {
      return append({ ...event, id: randomUUID(), capturedAt: now().toISOString() });
    },
    remove(id) {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].id === id || events[i].parentId === id) events.splice(i, 1);
      }
    },
    clear() {
      events.length = 0;
    },
    list() {
      return events;
    },
  };
}
