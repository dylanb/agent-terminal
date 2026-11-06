import { randomUUID } from 'node:crypto';
import type { ControllerClearOutcome, ControllerTerminal, ControllerTimelineEntry, ControllerWorkStatus } from '../shared/ipc';
import type { NotificationCondition } from '../shared/controllerProtocol';
import { ACTIVITY_WORDS } from '../shared/controllerCardClassification';

const TIMELINE_LIMIT = 3;
const REQUEST_RAISED_TEXT = 'Request raised';
const DISCONNECTED_TEXT = 'Disconnected';

export interface ControllerTimelines<Connection> {
  registered(connection: Connection, terminal: ControllerTerminal, directoryMembers: readonly ControllerTerminal[], notifications: boolean): void;
  notified(connection: Connection, terminal: ControllerTerminal, notification: NotificationCondition | null, report: 'arrival' | 'current', overlapping: boolean): boolean;
  reported(connection: Connection, terminal: ControllerTerminal, work: ControllerWorkStatus, overlapping: boolean): void;
  departed(connection: Connection, card: ControllerTerminal, stillRegistered: ReadonlyArray<readonly [Connection, ControllerTerminal]>): void;
  clear(terminal: ControllerTerminal, revision: string, overlapping: boolean): ControllerClearOutcome;
  dismissed(directory: string): void;
}

function flowChange(previous: ControllerWorkStatus['flow'], next: ControllerWorkStatus['flow']): string | undefined {
  if (previous.availability !== 'known' || next.availability !== 'known') return undefined;
  if (next.assignment === 'completed' && previous.assignment !== 'completed') return 'Completed';
  if (previous.step !== next.step) return `Step: ${next.step}`;
  if (previous.assignment === 'unassigned' && next.assignment === 'assigned') return 'Run started';
  return undefined;
}

function statusChanges(previous: ControllerWorkStatus | undefined, next: ControllerWorkStatus): string[] {
  if (!previous) return [];
  const changes: string[] = [];
  if (previous.activity !== next.activity) changes.push(ACTIVITY_WORDS[next.activity]);
  if (!previous.error !== !next.error) changes.push(next.error ? 'Flow error' : 'Flow error cleared');
  if (previous.attention && !next.attention) changes.push('Request cleared');
  const flow = flowChange(previous.flow, next.flow);
  if (flow) changes.push(flow);
  return changes;
}

export function createControllerTimelines<Connection>(): ControllerTimelines<Connection> {
  const notifying = new Map<Connection, boolean>();
  const current = new Map<Connection, NotificationCondition | null>();
  const comparedWork = new Map<Connection, ControllerWorkStatus>();
  const requestEntries = new Map<Connection, ControllerTimelineEntry>();
  const directoryConditions = new Map<string, { current?: string; cleared?: string; olderRequestShown?: boolean }>();
  const renewClearTarget = (terminal: ControllerTerminal) => {
    if (terminal.timeline) terminal.clearHistoryTarget = { id: terminal.id, launchDirectory: terminal.launchDirectory, revision: randomUUID() };
    else delete terminal.clearHistoryTarget;
  };
  const insert = (terminal: ControllerTerminal, entry: ControllerTimelineEntry) => {
    const timeline = terminal.timeline ??= [];
    timeline.unshift(entry);
    timeline.splice(TIMELINE_LIMIT);
    renewClearTarget(terminal);
  };
  const receive = (connection: Connection, terminal: ControllerTerminal, notification: NotificationCondition) => {
    if (directoryConditions.get(terminal.launchDirectory)?.cleared === notification.conditionId) return;
    const repeated = terminal.timeline?.find(entry => entry.kind === 'notification' && entry.message === notification.message);
    if (repeated?.kind === 'notification') {
      repeated.count += 1;
      renewClearTarget(terminal);
    } else {
      const pairedStatus = requestEntries.get(connection);
      if (pairedStatus?.kind === 'status') terminal.timeline = terminal.timeline?.filter(entry => entry !== pairedStatus);
      const entry: ControllerTimelineEntry = { kind: 'notification', message: notification.message, receivedAt: Date.now(), count: 1 };
      requestEntries.set(connection, entry);
      insert(terminal, entry);
    }
  };
  const recordStatus = (connection: Connection, terminal: ControllerTerminal, notificationsSupported: boolean, previous: ControllerWorkStatus | undefined, work: ControllerWorkStatus) => {
    for (const text of statusChanges(previous, work)) insert(terminal, { kind: 'status', text, receivedAt: Date.now() });
    if (previous?.attention && !work.attention) requestEntries.delete(connection);
    const directory = directoryConditions.get(terminal.launchDirectory) ?? {};
    directoryConditions.set(terminal.launchDirectory, directory);
    const olderRequestShown = directory.olderRequestShown === true;
    if (!notificationsSupported) directory.olderRequestShown = work.attention !== null;
    if (!work.attention || previous?.attention) return;
    if (!notificationsSupported) {
      if (!olderRequestShown) insert(terminal, { kind: 'status', text: REQUEST_RAISED_TEXT, receivedAt: Date.now() });
    } else if (previous) {
      const standing = requestEntries.get(connection);
      const timeline = terminal.timeline ?? [];
      const at = standing ? timeline.indexOf(standing) : -1;
      if (at > 0) timeline.unshift(...timeline.splice(at, 1));
      else if (!standing) {
        const entry: ControllerTimelineEntry = { kind: 'status', text: REQUEST_RAISED_TEXT, receivedAt: Date.now() };
        requestEntries.set(connection, entry);
        insert(terminal, entry);
      }
    }
  };
  return {
    registered(connection, terminal, directoryMembers, notifications) {
      notifying.set(connection, notifications);
      renewClearTarget(terminal);
      if (directoryMembers.length > 1) {
        directoryConditions.delete(terminal.launchDirectory);
        for (const peer of directoryMembers) {
          delete peer.timeline;
          renewClearTarget(peer);
        }
      }
    },
    notified(connection, terminal, notification, report, overlapping) {
      const previous = current.get(connection);
      current.set(connection, notification);
      if (!notification) requestEntries.delete(connection);
      if (overlapping) return false;
      const state = directoryConditions.get(terminal.launchDirectory) ?? {};
      state.current = notification?.conditionId;
      directoryConditions.set(terminal.launchDirectory, state);
      if (!notification || (report !== 'arrival' && previous !== undefined)) return false;
      receive(connection, terminal, notification);
      return true;
    },
    reported(connection, terminal, work, overlapping) {
      if (work.unavailableReason !== undefined) return;
      const previous = comparedWork.get(connection);
      comparedWork.set(connection, work);
      if (!overlapping) recordStatus(connection, terminal, notifying.get(connection) === true, previous, work);
    },
    departed(connection, card, stillRegistered) {
      notifying.delete(connection);
      current.delete(connection);
      comparedWork.delete(connection);
      requestEntries.delete(connection);
      if (!stillRegistered.length) insert(card, { kind: 'status', text: DISCONNECTED_TEXT, receivedAt: Date.now() });
      else if (stillRegistered.length === 1) {
        const [survivorConnection, survivor] = stillRegistered[0];
        const condition = current.get(survivorConnection);
        directoryConditions.set(survivor.launchDirectory, { current: condition?.conditionId });
        comparedWork.delete(survivorConnection);
        if (condition) receive(survivorConnection, survivor, condition);
      }
    },
    clear(terminal, revision, overlapping) {
      if (overlapping || terminal.clearHistoryTarget?.revision !== revision) return 'stale';
      renewClearTarget(terminal);
      terminal.timeline = [];
      const state = directoryConditions.get(terminal.launchDirectory);
      if (state) state.cleared = state.current;
      return 'cleared';
    },
    dismissed(directory) {
      directoryConditions.delete(directory);
    },
  };
}
