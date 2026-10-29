import type { ControllerTerminal } from '../../src/shared/ipc';

export type ClearOutcome = 'cleared' | 'stale' | 'unavailable';
export interface ClearHistoryApi {
  clearHistory?(observed: ControllerTerminal): Promise<ClearOutcome> | ClearOutcome;
}
export const clearHistoryChannel = 'controller:clearHistory';
export const clearObserved = async (api: object, observed: ControllerTerminal): Promise<ClearOutcome | undefined> =>
  (api as ClearHistoryApi).clearHistory?.(structuredClone(observed));
