import type {
  DestRelativePath,
  InstallDestinationId,
  InstallExamplesPreview,
  InstallExamplesResult,
  InstallPreviewId,
  RetiredExample,
  SetupDismissReply,
  SetupStatusReply,
} from '../../src/shared/ipc';
import type { HostedAgentState } from '../../src/shared/ipc';
import type { SetupConditionEntry, SetupDismissal } from '../../src/shared/setupCheck';
import type { SetupCheckDialogDeps } from '../../src/renderer/src/setupCheckDialog';
import type { SetupFlowRun } from '../../src/renderer/src/setupFlowRun';

/** Repository keys no two of which share a path segment, so a dialog naming one cannot be read as naming
 *  another. */
export const REPO = {
  alpha: '/work/alpha-orchard',
  bravo: '/srv/bravo-quarry',
  charlie: '/home/op/charlie-delta',
} as const;

/** One entry per failure kind the slice lists. */
export const ENTRY = {
  absent: { condition: 'capabilities', failure: 'absent' },
  malformed: { condition: 'capabilities', failure: 'malformed' },
  confinement: { condition: 'capabilities', failure: 'confinement' },
  notIgnored: { condition: 'ignore', failure: 'not-ignored' },
  unchecked: { condition: 'ignore', failure: 'unchecked' },
  examplesStale: { condition: 'examples', failure: 'stale' },
  examplesUnchecked: { condition: 'examples', failure: 'unchecked' },
} as const satisfies Record<string, SetupConditionEntry>;

/** The app version every scripted status reply names. */
export const APP_VERSION = '7.3.1-fixture';

/** The status of a git repository; the repo-setup flow is not installed unless `setupFlowInstalled` says so. */
export const repoStatus = (repoKey: string, entries: SetupConditionEntry[], setupFlowInstalled = false): SetupStatusReply => ({
  ok: true,
  repoKey,
  isRepository: true,
  appVersion: APP_VERSION,
  setupFlowInstalled,
  entries,
});

/** The status of a directory that is not a git repository. */
export const plainStatus = (dir: string, entries: SetupConditionEntry[]): SetupStatusReply => ({
  ok: true,
  repoKey: dir,
  isRepository: false,
  appVersion: APP_VERSION,
  setupFlowInstalled: false,
  entries,
});

const EMPTY_REPORT = { created: [], overwritten: [], skipped: [], notInstalled: [], removed: [] };

export const cleanPreview = (id: string): InstallExamplesPreview => ({
  ok: true,
  previewId: id as InstallPreviewId,
  destinations: [{ destination: 'flow', conflict: false }],
  retired: [],
  retiredFallback: null,
});

export const differingPreview = (id: string, differing: InstallDestinationId[]): InstallExamplesPreview => ({
  ok: true,
  previewId: id as InstallPreviewId,
  destinations: differing.map((destination) => ({
    destination,
    conflict: true as const,
    files: [`${destination}-file.yaml` as DestRelativePath],
  })),
  retired: [],
  retiredFallback: null,
});

export const retiredPreview = (id: string): InstallExamplesPreview => ({
  ok: true,
  previewId: id as InstallPreviewId,
  destinations: [{ destination: 'flow', conflict: false }],
  retired: [{ destination: 'flow', rel: 'old-flow' as DestRelativePath, kind: 'retired-flow' } satisfies RetiredExample],
  retiredFallback: null,
});

export const installSucceeded = (): InstallExamplesResult => ({ ok: true, ...EMPTY_REPORT });
export const installFailed = (error: string): InstallExamplesResult => ({ ok: false, error, ...EMPTY_REPORT });

export interface InstallRequest {
  previewId: string;
  replace: InstallDestinationId[];
  removeRetired: boolean;
}

type ScriptedPreview = InstallExamplesPreview | { reject: string };
type ScriptedInstall = InstallExamplesResult | { reject: string };

type Scripted = SetupStatusReply | { reject: string };
type ScriptedDismiss = SetupDismissReply | { reject: string };
type ScriptedSetupRun = SetupFlowRun | { reject: string };

/** The dialog's deps over scripted status replies, consumed in order per repository key; an unscripted key
 *  answers a failed reply. `onFocusLost` lands focus on
 *  whatever `landFocusOn` names, as the composition root's fallback does. Every status request is
 *  recorded by repository; `examples` scripts the preview and install replies and records each install request. Each `dismiss` call is recorded, and answers the
 *  next reply `answerDismiss` queued, or `{ ok: true }` when none is queued. Each `runSetupFlow` call is recorded
 *  by repository, and answers (or rejects with) the next result `setupFlow.answer` queued, or `{ ok: true }` when none is queued; each reason `onSetupLoopFailed` reports is recorded. */
export function fakeSetupDeps() {
  const scripts = new Map<string, Scripted[]>();
  const deliveries = new Map<string, Array<() => void>>();
  const holds = new Map<string, Promise<void>>();
  let landing: HTMLElement | null = null;
  const statusRequests: string[] = [];
  const previewReplies: ScriptedPreview[] = [];
  const installReplies: ScriptedInstall[] = [];
  const installRequests: InstallRequest[] = [];
  let previewCount = 0;
  let previewHold: Promise<void> | null = null;
  let installHold: Promise<void> | null = null;
  const dismissals: SetupDismissal[] = [];
  const dismissReplies: ScriptedDismiss[] = [];
  const setupRuns: string[] = [];
  const setupRunReplies: ScriptedSetupRun[] = [];
  let setupRunHold: Promise<void> | null = null;
  const setupLoopFailures: string[] = [];
  let agentState: HostedAgentState = 'idle';
  const agentListeners = new Set<(state: HostedAgentState) => void>();
  const deps: SetupCheckDialogDeps = {
    status: async (repoKey) => {
      statusRequests.push(repoKey);
      const held = holds.get(repoKey);
      if (held !== undefined) {
        holds.delete(repoKey);
        await held;
      }
      const next = scripts.get(repoKey)?.shift();
      for (const resolve of deliveries.get(repoKey)?.splice(0) ?? []) queueMicrotask(resolve);
      if (next === undefined) return { ok: false, reason: `no status scripted for ${repoKey}` };
      if ('reject' in next) throw new Error(next.reject);
      return next;
    },
    dismiss: async (dismissal) => {
      dismissals.push(dismissal);
      const next = dismissReplies.shift() ?? { ok: true };
      if ('reject' in next) throw new Error(next.reject);
      return next;
    },
    previewExamples: async () => {
      previewCount += 1;
      const held = previewHold;
      previewHold = null;
      if (held !== null) await held;
      const next = previewReplies.shift() ?? { ok: false as const, error: 'no preview scripted' };
      if ('reject' in next) throw new Error(next.reject);
      return next;
    },
    installExamples: async (previewId, choice) => {
      installRequests.push({ previewId, replace: [...choice.replace], removeRetired: choice.removeRetired });
      const held = installHold;
      installHold = null;
      if (held !== null) await held;
      const next = installReplies.shift() ?? installFailed('no install scripted');
      if ('reject' in next) throw new Error(next.reject);
      return next;
    },
    runSetupFlow: async (repoKey) => {
      setupRuns.push(repoKey);
      const held = setupRunHold;
      setupRunHold = null;
      if (held !== null) await held;
      const next = setupRunReplies.shift() ?? { ok: true };
      if ('reject' in next) throw new Error(next.reject);
      return next;
    },
    onSetupLoopFailed: (reason) => {
      setupLoopFailures.push(reason);
    },
    agentState: () => agentState,
    onAgentStateChanged: (cb) => {
      agentListeners.add(cb);
      return () => agentListeners.delete(cb);
    },
    onFocusLost: () => landing?.focus(),
  };
  return {
    deps,
    /** Queue the replies the next status requests for `repoKey` get, in order. */
    answer(repoKey: string, ...replies: Scripted[]): void {
      scripts.set(repoKey, [...(scripts.get(repoKey) ?? []), ...replies]);
    },
    /** Settles once the next status request for `repoKey` has been answered and a task has run after it. */
    answered(repoKey: string): Promise<void> {
      return new Promise<void>((resolve) => {
        deliveries.set(repoKey, [...(deliveries.get(repoKey) ?? []), resolve]);
      }).then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    },
    /** Keeps the next status reply for `repoKey` pending until the returned release runs. */
    hold(repoKey: string): () => void {
      let release!: () => void;
      holds.set(repoKey, new Promise<void>((resolve) => (release = resolve)));
      return release;
    },
    /** Queue the replies the next `dismiss` calls get, in order. */
    answerDismiss(...replies: ScriptedDismiss[]): void {
      dismissReplies.push(...replies);
    },
    /** Every dismissal the dialog asked to record, in order. */
    dismissals: (): SetupDismissal[] => [...dismissals],
    statusRequests: (): string[] => [...statusRequests],
    examples: {
      preview(...replies: ScriptedPreview[]): void {
        previewReplies.push(...replies);
      },
      install(...replies: ScriptedInstall[]): void {
        installReplies.push(...replies);
      },
      holdPreview(): () => void {
        let release!: () => void;
        previewHold = new Promise<void>((resolve) => (release = resolve));
        return release;
      },
      holdInstall(): () => void {
        let release!: () => void;
        installHold = new Promise<void>((resolve) => (release = resolve));
        return release;
      },
      requests: (): InstallRequest[] => installRequests.map((r) => ({ ...r, replace: [...r.replace] })),
      previews: (): number => previewCount,
    },
    setupFlow: {
      /** Queue the results the next `runSetupFlow` calls get, in order. */
      answer(...results: ScriptedSetupRun[]): void {
        setupRunReplies.push(...results);
      },
      hold(): () => void {
        let release!: () => void;
        setupRunHold = new Promise<void>((resolve) => (release = resolve));
        return release;
      },
      /** Each repository `runSetupFlow` was asked to run the setup flow in, in order. */
      runs: (): string[] => [...setupRuns],
      /** Each reason the dialog reported a setup loop that did not start for, in order. */
      failures: (): string[] => [...setupLoopFailures],
    },
    /** The agent at the terminal's prompt; one is there and idle, unless a test says otherwise. */
    agent: {
      set(state: HostedAgentState): void {
        agentState = state;
        for (const cb of [...agentListeners]) cb(state);
      },
    },
    /** Where `onFocusLost` lands focus. */
    landFocusOn(el: HTMLElement): void {
      landing = el;
    },
  };
}
