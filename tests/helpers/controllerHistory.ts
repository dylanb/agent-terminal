import type { ControllerTerminal } from '../../src/shared/ipc';

export interface ReceivedEntry { message: string; receivedAt: number; count: number }
export type HistoryTerminal = ControllerTerminal & { notifications?: ReceivedEntry[] };
export const notificationEntries = (terminal: HistoryTerminal | undefined): ReceivedEntry[] => terminal?.notifications ?? (terminal?.latestNotification ? [{ ...terminal.latestNotification, count: 1 }] : []);
