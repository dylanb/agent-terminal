import type { ControllerIncompatibility } from './controller';
import type { ChannelSpecs, SessionId } from './session';

export const STARTUP_CHANNELS = {
  startupReady: {
    name: 'startup:ready',
    does: 'The renderer waits until controller registration and main-process setup are done.',
  },
  startupRendered: {
    name: 'startup:rendered',
    does: 'The renderer reports its UI is installed, so main releases the buffered shell output.',
  },
  startupIncompatible: {
    name: 'startup:incompatible',
    does: 'Main reports that this terminal and the running controller speak incompatible protocol versions.',
  },
} as const satisfies ChannelSpecs;

export interface StartupIncompatibleMsg extends ControllerIncompatibility { sessionId: SessionId }

export interface StartupApi {
  ready(): Promise<void>;
  rendered(): void;
  onIncompatible(cb: (report: ControllerIncompatibility) => void): () => void;
}
