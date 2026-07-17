// STUB (RED): the §27 app-owned loop-state persistence. Filled in the GREEN commit.

export const APP_LOOP_STATE_SCHEMA = 1;

export type AppLoopStatus = 'working' | 'error' | 'complete';

export interface AppLoopRunState {
  loop: string;
  step: string;
  turnKey: string;
  status: AppLoopStatus;
  errorReason?: string;
}

export function serializeAppLoopState(_state: AppLoopRunState, _now: () => Date): string {
  return '';
}

export function parseAppLoopState(_text: string): AppLoopRunState | null {
  return null;
}

export function writeAppLoopState(_repoDir: string, _state: AppLoopRunState, _now?: () => Date): void {
  /* stub */
}

export function readAppLoopState(_repoDir: string): AppLoopRunState | null {
  return null;
}
