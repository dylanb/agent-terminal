// File-backed persistence for the monitor event store (§8.4): `<launchRoot>/.agent-terminal/
// monitor-events.json`. The app NEVER modifies the user's .gitignore (no-gitignore-writes rule);
// whether to ignore or commit `.agent-terminal/` is the user's choice.
// The file is an UNTRUSTED source — a cloned repo can ship one — so each loaded element is
// validated to the MonitorEvent shape before it can seed the store and replay into the monitor
// pane; a missing/corrupt/foreign file degrades to an empty list (never a throw).

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { BufferType, MonitorEvent, MonitorEventSource, MonitorEventType } from '../shared/ipc';
import { isInjectableEventType } from '../shared/injectableEvents';
import type { MonitorEventPersistence } from './eventStore';
import { isRecord } from './yamlRecord';

const EVENTS_REL = path.join('.agent-terminal', 'monitor-events.json');

/** A file larger than this is refused (load → empty) rather than read into the main process at
 *  startup, so a cloned repo cannot stall the app with a giant planted file (CWE-400). */
export const MAX_EVENTS_FILE_BYTES = 16 * 1024 * 1024;

// Runtime membership tests for the §15.4 `MonitorEventType`/`MonitorEventSource`/`BufferType` unions
// (a type-only union has no runtime form to test against).
const EVENT_TYPES: Record<MonitorEventType, true> = {
  capture: true, report: true, finding: true, 'tool-use': true, diff: true, completion: true, 'command-output': true,
};
const EVENT_SOURCES: Record<MonitorEventSource, true> = {
  selection: true, 'shadow-scan': true, 'shell-integration': true, heuristic: true,
};
const BUFFER_TYPES: Record<BufferType, true> = { normal: true, alternate: true };

const isString = (v: unknown): boolean => typeof v === 'string';
const inSet = (set: Record<string, true>) => (v: unknown): boolean =>
  typeof v === 'string' && Object.prototype.hasOwnProperty.call(set, v);
const isCell = (v: unknown): boolean => isRecord(v) && typeof v.x === 'number' && typeof v.y === 'number';
const isRange = (v: unknown): boolean =>
  v === null ||
  (isRecord(v) && isCell(v.start) && isCell(v.end) && typeof v.baseY === 'number' && inSet(BUFFER_TYPES)(v.bufferType));

// Per-field validation of the §15.4 `MonitorEvent` shape.
const FIELD_CHECKS: Record<keyof MonitorEvent, (v: unknown) => boolean> = {
  id: isString,
  sessionId: isString,
  type: inSet(EVENT_TYPES),
  source: inSet(EVENT_SOURCES),
  text: isString,
  range: isRange,
  parentId: (v) => v === null || isString(v),
  truncated: (v) => typeof v === 'boolean',
  capturedAt: isString,
};

function isMonitorEvent(v: unknown): v is MonitorEvent {
  if (!isRecord(v)) return false;
  return (Object.keys(FIELD_CHECKS) as (keyof MonitorEvent)[]).every((k) => FIELD_CHECKS[k](v[k]));
}

export function createMonitorEventsFile(launchRoot: string): MonitorEventPersistence {
  const file = path.join(launchRoot, EVENTS_REL);
  return {
    load() {
      try {
        if (statSync(file).size > MAX_EVENTS_FILE_BYTES) return [];
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(raw)) return [];
        return raw.filter(isMonitorEvent).filter((e) => !isInjectableEventType(e.type));
      } catch {
        return [];
      }
    },
    save(events) {
      mkdirSync(path.dirname(file), { recursive: true });
      // Unpredictable temp name + exclusive create (wx): an untrusted repo cannot pre-plant a symlink
      // at the temp path for the write to follow (CWE-59). Captured output may carry secrets → 0o600.
      const tmp = `${file}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(events), { mode: 0o600, flag: 'wx' });
      renameSync(tmp, file);
    },
  };
}
