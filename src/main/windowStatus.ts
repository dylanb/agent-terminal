import type { MonitorUpdateMsg } from '../shared/ipc';
import type { ShadowStatus } from './shadow';
import { sameWaitingValue, type ControllerActivity, type WaitingValue } from '../shared/waiting';

/** What the window is sent: the monitor status update, but for its session. */
export type WindowStatusUpdate = MonitorUpdateMsg extends infer M ? M extends unknown ? Omit<M, 'sessionId'> : never : never;

export interface WindowStatusDeps {
  deliver(update: WindowStatusUpdate): void;
}

export interface WindowStatus {
  /** A new screen status: always delivered. */
  screen(status: ShadowStatus): void;
  /** The Waiting detector's activity: delivered only when it changes the Waiting value the window shows. */
  activity(activity: ControllerActivity): void;
  /** The Waiting value the window's strips show while the screen is quiet. */
  waiting(): WaitingValue | null;
}

/** Working wins: an active screen carries no Waiting value. */
function windowUpdate({ agentState, ...status }: ShadowStatus, waiting: WaitingValue | null): WindowStatusUpdate {
  return agentState === 'active' ? { ...status, agentState, waiting: null } : { ...status, agentState, waiting };
}

/** The window's strips follow the latest lookup, never the controller's grace period. */
export function createWindowStatus(deps: WindowStatusDeps): WindowStatus {
  let waiting: WaitingValue | null = null;
  let screen: ShadowStatus | null = null;
  let shown: WaitingValue | null = null;
  const send = (status: ShadowStatus): void => {
    screen = status;
    const update = windowUpdate(status, waiting);
    shown = update.waiting;
    deps.deliver(update);
  };
  return {
    screen: send,
    activity(activity) {
      waiting = activity.activity === 'waiting' ? activity.waiting : null;
      if (screen && !sameWaitingValue(shown, windowUpdate(screen, waiting).waiting)) send(screen);
    },
    waiting: () => waiting,
  };
}
