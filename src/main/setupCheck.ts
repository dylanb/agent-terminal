import type { SetupDismissReply, SetupStatusReply } from '../shared/ipc';
import type { SetupConditionEntry, SetupDismissal } from '../shared/setupCheck';
import type { IgnoreAnswer } from './gitIgnoreCheck';
import type { ExamplesCurrency } from './installExamples';
import type { LoopCapabilitiesLoad } from './loopCapabilities';
import type { SetupDismissals } from './setupDismissals';

export interface SetupCheckDeps {
  examplesCurrent(): ExamplesCurrency;
  isGitRepository(dir: string): boolean;
  agentTerminalIgnored(repoDir: string): Promise<IgnoreAnswer>;
  loadCapabilities(repoDir: string): LoopCapabilitiesLoad;
  appVersion: string;
  dismissals: SetupDismissals;
}

export interface SetupCheck {
  status(repoKey: string): Promise<SetupStatusReply>;
  dismiss(dismissal: SetupDismissal): SetupDismissReply;
}

const IGNORE_ENTRY: Record<IgnoreAnswer, SetupConditionEntry | null> = {
  ignored: null,
  'not-ignored': { condition: 'ignore', failure: 'not-ignored' },
  unknown: { condition: 'ignore', failure: 'unchecked' },
};

function examplesEntry(examplesCurrent: () => ExamplesCurrency): SetupConditionEntry | null {
  let currency: ExamplesCurrency;
  try {
    currency = examplesCurrent();
  } catch {
    return { condition: 'examples', failure: 'unchecked' };
  }
  if (!currency.ok) return { condition: 'examples', failure: 'unchecked' };
  return currency.current ? null : { condition: 'examples', failure: 'stale' };
}

export function createSetupCheck(deps: SetupCheckDeps): SetupCheck {
  return {
    async status(repoKey) {
      const examples = examplesEntry(() => deps.examplesCurrent());
      if (!deps.isGitRepository(repoKey)) {
        return { ok: true, repoKey, isRepository: false, appVersion: deps.appVersion, entries: examples ? [examples] : [] };
      }
      const ignore = await deps.agentTerminalIgnored(repoKey).catch((): IgnoreAnswer => 'unknown');
      const capabilities = deps.loadCapabilities(repoKey);
      const entries: SetupConditionEntry[] = [];
      if (examples) entries.push(examples);
      const ignoreEntry = IGNORE_ENTRY[ignore];
      if (ignoreEntry) entries.push(ignoreEntry);
      if (!capabilities.ok) entries.push({ condition: 'capabilities', failure: capabilities.cause });
      return { ok: true, repoKey, isRepository: true, appVersion: deps.appVersion, entries };
    },
    dismiss: () => ({ ok: true }),
  };
}

/** The check runs unless `APP_SETUP_CHECK` is exactly `off`, the e2e suite's switch for specs that do not test it. */
export function setupCheckEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.APP_SETUP_CHECK !== 'off';
}
