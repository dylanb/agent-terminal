import type { SetupConditionEntry, SetupDismissal } from '../setupCheck';
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
} as const satisfies ChannelSpecs;

export interface SetupStatusMsg {
  sessionId: SessionId;
  repoKey: string;
}

export type SetupStatusReply =
  | { ok: true; repoKey: string; isRepository: boolean; appVersion: string; entries: SetupConditionEntry[] }
  | { ok: false; reason: string };

export interface SetupDismissMsg {
  sessionId: SessionId;
  dismissal: SetupDismissal;
}

export type SetupDismissReply = { ok: true } | { ok: false; reason: string };

export interface SetupApi {
  status(repoKey: string): Promise<SetupStatusReply>;
  dismiss(dismissal: SetupDismissal): Promise<SetupDismissReply>;
}
