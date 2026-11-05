import type { SetupStatusReply } from '../shared/ipc';
import type { SetupConditionEntry } from '../shared/setupCheck';
import type { IgnoreAnswer } from './gitIgnoreCheck';
import type { ExamplesCurrency } from './installExamples';
import type { LoopCapabilitiesLoad } from './loopCapabilities';

export interface SetupCheckDeps {
  examplesCurrent(): ExamplesCurrency;
  isGitRepository(dir: string): boolean;
  agentTerminalIgnored(repoDir: string): Promise<IgnoreAnswer>;
  loadCapabilities(repoDir: string): LoopCapabilitiesLoad;
}

export interface SetupCheck {
  status(repoKey: string): Promise<SetupStatusReply>;
}

const IGNORE_ENTRY: Record<IgnoreAnswer, SetupConditionEntry | null> = {
  ignored: null,
  'not-ignored': { condition: 'ignore', failure: 'not-ignored' },
  unknown: { condition: 'ignore', failure: 'unchecked' },
};

export function createSetupCheck(deps: SetupCheckDeps): SetupCheck {
  return {
    async status(repoKey) {
      if (!deps.isGitRepository(repoKey)) return { ok: true, repoKey, isRepository: false, entries: [] };
      const ignore = await deps.agentTerminalIgnored(repoKey).catch((): IgnoreAnswer => 'unknown');
      const capabilities = deps.loadCapabilities(repoKey);
      const entries: SetupConditionEntry[] = [];
      const ignoreEntry = IGNORE_ENTRY[ignore];
      if (ignoreEntry) entries.push(ignoreEntry);
      if (!capabilities.ok) entries.push({ condition: 'capabilities', failure: capabilities.cause });
      return { ok: true, repoKey, isRepository: true, entries };
    },
  };
}

/** The check runs unless `APP_SETUP_CHECK` is exactly `off`, the e2e suite's switch for specs that do not test it. */
export function setupCheckEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.APP_SETUP_CHECK !== 'off';
}
