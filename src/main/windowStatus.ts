import type { AgentState, MonitorUpdateMsg, ScreenWaiting } from '../shared/ipc';
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
  /** The screen activity and Waiting value last delivered; quiet with none before the first screen status. */
  shown(): ScreenWaiting;
}

/** Working wins: an active screen carries no Waiting value. */
function screenWaiting(agentState: AgentState, waiting: WaitingValue | null): ScreenWaiting {
  return agentState === 'active' ? { agentState, waiting: null } : { agentState, waiting };
}

/** The window's strips follow the latest lookup, never the controller's grace period. */
export function createWindowStatus(deps: WindowStatusDeps): WindowStatus {
  let waiting: WaitingValue | null = null;
  let screen: ShadowStatus | null = null;
  let shown: ScreenWaiting = { agentState: 'quiet', waiting: null };
  const send = (status: ShadowStatus): void => {
    screen = status;
    shown = screenWaiting(status.agentState, waiting);
    deps.deliver({ ...status, ...shown });
  };
  return {
    screen: send,
    activity(activity) {
      waiting = activity.activity === 'waiting' ? activity.waiting : null;
      if (screen && !sameWaitingValue(shown.waiting, screenWaiting(screen.agentState, waiting).waiting)) send(screen);
    },
    shown: () => shown,
  };
}
