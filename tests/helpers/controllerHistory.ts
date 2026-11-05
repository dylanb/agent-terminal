import type { ControllerTerminal, ControllerTimelineEntry } from '../../src/shared/ipc';

export interface ReceivedEntry { message: string; receivedAt: number; count: number }
export type HistoryTerminal = ControllerTerminal;
type Timelined = { timeline?: ControllerTimelineEntry[] };

export const timelineOf = (holder: Timelined | undefined): ControllerTimelineEntry[] => holder?.timeline ?? [];
export const notificationEntries = (holder: Timelined | undefined): ReceivedEntry[] =>
  timelineOf(holder).flatMap(item => (item.kind === 'notification' ? [{ message: item.message, receivedAt: item.receivedAt, count: item.count }] : []));
export const statusEntries = (holder: Timelined | undefined): Array<{ text: string; receivedAt: number }> =>
  timelineOf(holder).flatMap(item => (item.kind === 'status' ? [{ text: item.text, receivedAt: item.receivedAt }] : []));

export const notificationItem = (message: string, receivedAt: number, count = 1): ControllerTimelineEntry => ({ kind: 'notification', message, receivedAt, count });
export const statusItem = (text: string, receivedAt: number): ControllerTimelineEntry => ({ kind: 'status', text, receivedAt });
