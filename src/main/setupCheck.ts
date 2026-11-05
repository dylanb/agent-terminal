import type { SetupStatusReply } from '../shared/ipc';
import type { IgnoreAnswer } from './gitIgnoreCheck';
import type { LoopCapabilitiesLoad } from './loopCapabilities';

export interface SetupCheckDeps {
  isGitRepository(dir: string): boolean;
  agentTerminalIgnored(repoDir: string): Promise<IgnoreAnswer>;
  loadCapabilities(repoDir: string): LoopCapabilitiesLoad;
}

export interface SetupCheck {
  status(repoKey: string): Promise<SetupStatusReply>;
}

export function createSetupCheck(_deps: SetupCheckDeps): SetupCheck {
  return { status: async () => ({ ok: false, reason: 'the setup check is not built yet' }) };
}

export function setupCheckEnabled(_env: Readonly<Record<string, string | undefined>>): boolean {
  return false;
}
