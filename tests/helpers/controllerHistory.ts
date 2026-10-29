import type { ControllerNotificationEntry, ControllerTerminal } from '../../src/shared/ipc';

export type ReceivedEntry = ControllerNotificationEntry;
export type HistoryTerminal = ControllerTerminal;
export const notificationEntries = (terminal: HistoryTerminal | undefined): ReceivedEntry[] => terminal?.notifications ?? [];
