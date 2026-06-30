// File-backed persistence for the monitor event store (§8.4): `<launchRoot>/.agent-terminal/
// monitor-events.json`. The app NEVER modifies the user's .gitignore (no-gitignore-writes rule);
// whether to ignore or commit `.agent-terminal/` is the user's choice.
// The file is an UNTRUSTED source — a cloned repo can ship one — so each loaded element is
// validated to the MonitorEvent shape before it can seed the store and replay into the monitor
// pane; a missing/corrupt/foreign file degrades to an empty list (never a throw).

import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { BufferType, MonitorEvent, MonitorEventSource, MonitorEventType } from '../shared/ipc';
import { isInjectableEventType } from '../shared/injectableEvents';
import { atomicWriteFileSync, containerIsReal } from './atomicFile';
import type { MonitorEventPersistence } from './eventStore';
import { isRecord } from './yamlRecord';

const EVENTS_REL = path.join('.agent-terminal', 'monitor-events.json');

/** A file larger than this is refused (load → empty) rather than read into the main process at
 *  startup, so a cloned repo cannot stall the app with a giant planted file (CWE-400). */
export const MAX_EVENTS_FILE_BYTES = 16 * 1024 * 1024;

/** Test seam for the otherwise-unpredictable temp path `save()` writes-then-renames through. */
export interface MonitorEventsFileDeps {
  /** The temp path `save()` writes-then-renames through; defaults to an unpredictable per-write name
   *  so a cloned repo cannot pre-plant a symlink at it for the write to follow (CWE-59) — the `wx`
   *  exclusive create is the backstop. Tests override it to force the exclusive-create refusal path. */
  tmpPath?: (file: string) => string;
}

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

// §15.4
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

export function createMonitorEventsFile(
  launchRoot: string,
  deps: MonitorEventsFileDeps = {},
): MonitorEventPersistence {
  const file = path.join(launchRoot, EVENTS_REL);
  const dir = path.dirname(file);
  return {
    load() {
      try {
        if (!containerIsReal(dir)) return [];
        // lstat (not stat) so a symlink is rejected by isFile() instead of being followed: a symlink
        // to a special file (/dev/zero, a FIFO) reports size 0, slips a stat-based size cap, then
        // hangs/OOMs the synchronous read. Only a regular file under the cap is read (CWE-59/CWE-400).
        const st = lstatSync(file);
        if (!st.isFile() || st.size > MAX_EVENTS_FILE_BYTES) return [];
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(raw)) return [];
        return raw.filter(isMonitorEvent).filter((e) => !isInjectableEventType(e.type));
      } catch {
        return [];
      }
    },
    save(events) {
      // Captured output may carry secrets → owner-only; the symlinked-container refusal and the
      // unpredictable-temp + exclusive-create hardening live in atomicWriteFileSync (CWE-59).
      atomicWriteFileSync(file, JSON.stringify(events), { mode: 0o600, tmpPath: deps.tmpPath });
    },
  };
}
