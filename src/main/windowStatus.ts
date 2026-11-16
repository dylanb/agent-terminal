import type { AgentState, MonitorUpdateMsg, ScreenWaiting } from '../shared/ipc';
import type { ShadowStatus } from './shadow';
import { sameWaitingValue, type ControllerActivity, type WaitingValue } from '../shared/waiting';

export type WindowStatusUpdate = MonitorUpdateMsg extends infer M ? M extends unknown ? Omit<M, 'sessionId'> : never : never;

export interface WindowStatusDeps {
  deliver(update: WindowStatusUpdate): void;
}

export interface WindowStatus {
  screen(status: ShadowStatus): void;
  activity(activity: ControllerActivity): void;
  shown(): ScreenWaiting;
}

function screenWaiting(agentState: AgentState, waiting: WaitingValue | null): ScreenWaiting {
  return agentState === 'active' ? { agentState, waiting: null } : { agentState, waiting };
}

export function createWindowStatus(deps: WindowStatusDeps): WindowStatus {
  let waiting: WaitingValue | null = null;
  let screen: ShadowStatus | null = null;
  let shown: ScreenWaiting = Object.freeze({ agentState: 'quiet', waiting: null });
  const send = (status: ShadowStatus): void => {
    screen = status;
    shown = Object.freeze(screenWaiting(status.agentState, waiting));
    deps.deliver({ ...status, ...shown });
  };
  return {
    screen: send,
    activity(activity) {
      waiting = activity.activity === 'waiting' ? Object.freeze({ program: activity.waiting.program, others: activity.waiting.others }) : null;
      if (screen && !sameWaitingValue(shown.waiting, screenWaiting(screen.agentState, waiting).waiting)) send(screen);
    },
    shown: () => shown,
  };
}
