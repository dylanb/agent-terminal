// Monitor event list (§8.4): stamps captures and replays them to a (re)loaded monitor pane. An
// optional `persistence` backing makes the list durable across relaunch (§8.4); restore must hold
// regardless of how the prior instance terminated.

import { randomUUID } from 'node:crypto';
import type { MonitorCaptureMsg, MonitorEvent } from '../shared/ipc';

/** Durable backing for the event list. `load()` returns the persisted events (empty when
 *  absent/corrupt — never throws); `save()` receives the full current list to persist and may
 *  throw on I/O failure — the store treats it as best-effort and never lets that abort a mutation. */
export interface MonitorEventPersistence {
  load(): MonitorEvent[];
  save(events: readonly MonitorEvent[]): void;
}

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

export function createMonitorEventStore(
  opts: { now?: () => Date; persistence?: MonitorEventPersistence } = {},
): MonitorEventStore {
  const now = opts.now ?? (() => new Date());
  const persistence = opts.persistence;
  const events: MonitorEvent[] = persistence ? [...persistence.load()] : [];

  function save(): void {
    // Durability is best-effort: a save failure (read-only launch dir, ENOSPC, a planted path)
    // must never abort the capture/mutation critical path (CLAUDE.md best-effort-side-effect rule).
    try {
      persistence?.save(events);
    } catch {
      // best-effort write; a failure here is ignored, per the contract above.
    }
  }

  function append(event: MonitorEvent): MonitorEvent {
    events.push(event);
    save();
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
      save();
    },
    clear() {
      events.length = 0;
      save();
    },
    list() {
      return events;
    },
  };
}
