// In-memory monitor event list (§8.4): stamps captures and replays them to a
// (re)loaded monitor pane. No persistence this version.

import { randomUUID } from 'node:crypto';
import type { MonitorCaptureMsg, MonitorEvent } from '../shared/ipc';

export interface MonitorEventStore {
  addCapture(msg: MonitorCaptureMsg): MonitorEvent;
  list(): readonly MonitorEvent[];
}

export function createMonitorEventStore(opts: { now?: () => Date } = {}): MonitorEventStore {
  const now = opts.now ?? (() => new Date());
  const events: MonitorEvent[] = [];

  return {
    addCapture(msg) {
      const event: MonitorEvent = {
        id: randomUUID(),
        sessionId: msg.sessionId,
        type: 'capture',
        source: msg.source,
        text: msg.text,
        range: msg.range,
        capturedAt: now().toISOString(),
      };
      events.push(event);
      return event;
    },
    list() {
      return events;
    },
  };
}
