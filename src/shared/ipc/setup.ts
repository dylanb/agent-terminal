import type { SetupConditionEntry, SetupDismissal } from '../setupCheck';
import type { HostedAgentState } from './monitor';
import type { ChannelSpecs, SessionId } from './session';

export const SETUP_CHANNELS = {
  setupStatus: {
    name: 'setup:status',
    does: 'The renderer asks which setup conditions the repository fails that the operator has not dismissed.',
  },
  setupDismiss: {
    name: 'setup:dismiss',
    does: 'The renderer records a setup-check dismissal, for one repository or for one app version, and learns whether it was saved.',
  },
  setupAgentState: {
    name: 'setup:agentState',
    does: "The renderer asks whether an agent is at the terminal's prompt, and whether it is idle, which the setup loop needs.",
  },
  setupAgentStateChanged: {
    name: 'setup:agentStateChanged',
    does: "Main reports that the agent at the terminal's prompt started, went idle, became busy or left.",
  },
} as const satisfies ChannelSpecs;

export interface SetupStatusMsg {
  sessionId: SessionId;
  repoKey: string;
}

export type SetupStatusReply =
  | { ok: true; repoKey: string; isRepository: boolean; appVersion: string; setupFlowInstalled: boolean; entries: SetupConditionEntry[] }
  | { ok: false; reason: string };

export interface SetupDismissMsg {
  sessionId: SessionId;
  dismissal: SetupDismissal;
}

export type SetupDismissReply = { ok: true } | { ok: false; reason: string };

export interface SetupAgentStateMsg {
  sessionId: SessionId;
}

export interface SetupAgentStateChangedMsg {
  sessionId: SessionId;
  state: HostedAgentState;
}

export interface SetupApi {
  status(repoKey: string): Promise<SetupStatusReply>;
  dismiss(dismissal: SetupDismissal): Promise<SetupDismissReply>;
  agentState(): Promise<HostedAgentState>;
  /** Calls `cb` when the agent at the terminal's prompt changes state; returns its unsubscribe. */
  onAgentStateChanged(cb: (state: HostedAgentState) => void): () => void;
}
