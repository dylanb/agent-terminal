import type { WaitingValue } from '../shared/waiting';

export type WaitingPlatform = 'darwin' | 'linux';

export interface ProcessTableReading {
  /** The terminal's shell, whose foreground program is the agent. */
  readonly shellPid: number;
  readonly platform: WaitingPlatform;
}

export function waitingInTable(_psOutput: string, _reading: ProcessTableReading): WaitingValue | null {
  return null;
}
