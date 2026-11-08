import type { AgentState } from '../shared/ipc';
import type { ShadowStatus } from './shadow';
import { sameWaitingValue, type WaitingValue } from '../shared/waiting';

export interface WindowStatusUpdate {
  status: ShadowStatus;
  waiting: WaitingValue | null;
}

export interface WindowStatusDeps {
  /** The Waiting value the window shows while the screen is quiet. */
  waiting(): WaitingValue | null;
  deliver(update: WindowStatusUpdate): void;
}

export interface WindowStatus {
  /** A new screen status: always delivered. */
  screen(status: ShadowStatus): void;
  /** Delivers only when the Waiting value the window shows has changed. */
  refresh(): void;
}

/** Working wins: no Waiting value is ever shown beside an active screen. */
export function waitingBeside(screen: AgentState, waiting: WaitingValue | null): WaitingValue | null {
  return screen === 'active' ? null : waiting;
}

export function createWindowStatus(deps: WindowStatusDeps): WindowStatus {
  let sent: WindowStatusUpdate | null = null;
  const send = (status: ShadowStatus): void => {
    sent = { status, waiting: waitingBeside(status.agentState, deps.waiting()) };
    deps.deliver(sent);
  };
  return {
    screen: send,
    refresh() {
      if (sent && !sameWaitingValue(sent.waiting, waitingBeside(sent.status.agentState, deps.waiting()))) send(sent.status);
    },
  };
}
