import type { SetupConditionEntry } from '../setupCheck';
import type { ChannelSpecs, SessionId } from './session';

export const SETUP_CHANNELS = {
  setupStatus: {
    name: 'setup:status',
    does: 'The renderer asks which setup conditions the repository fails that the operator has not dismissed.',
  },
} as const satisfies ChannelSpecs;

export interface SetupStatusMsg {
  sessionId: SessionId;
  repoKey: string;
}

export type SetupStatusReply =
  | { ok: true; repoKey: string; isRepository: boolean; entries: SetupConditionEntry[] }
  | { ok: false; reason: string };

export interface SetupApi {
  status(repoKey: string): Promise<SetupStatusReply>;
}
