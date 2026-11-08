import type { AgentState } from '../shared/ipc';
import type { ShadowStatus } from './shadow';
import type { WaitingValue } from '../shared/waiting';

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

const sameWaiting = (a: WaitingValue | null, b: WaitingValue | null): boolean =>
  a === b || (a !== null && b !== null && a.program === b.program && a.others === b.others);

export function createWindowStatus(deps: WindowStatusDeps): WindowStatus {
  let sent: WindowStatusUpdate | null = null;
  const send = (status: ShadowStatus): void => {
    sent = { status, waiting: waitingBeside(status.agentState, deps.waiting()) };
    deps.deliver(sent);
  };
  return {
    screen: send,
    refresh() {
      if (sent && !sameWaiting(sent.waiting, waitingBeside(sent.status.agentState, deps.waiting()))) send(sent.status);
    },
  };
}
