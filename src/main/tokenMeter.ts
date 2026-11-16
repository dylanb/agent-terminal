import type { FlowStateView, FlowStatus, FlowTokensView } from '../shared/ipc';
import type { StepTokens } from '../shared/tokenCounts';
import { createLogCursors, sweepAgentUsage, type AgentLogRoots, type AgentUsageSweep, type LogCursors } from './agentUsage/sweep';
import { readAuditRun, readCurrentAuditRun, type AuditRunId } from './auditRun';
import { dashTokens, recordedWindows, stepTokens, unplacedRunTokens } from './stepTokens';

export const TOKEN_REFRESH_MS = 2_000;

export interface RefreshSchedule {
  /** Starts running `refresh` repeatedly; the returned function stops it. */
  start(refresh: () => Promise<void>): () => void;
}

export interface TokenMeterDeps {
  auditRoot: string;
  logRoots: AgentLogRoots;
  schedule: RefreshSchedule;
  showing: boolean;
  /** The time a count is read: an open step window ends now. */
  now(): number;
  /** A repo's token view changed, so its flow view must be pulled again. */
  changed(): void;
  log?(message: string, error: unknown): void;
}

export interface TokenMeter {
  /** `view` with the repo's counts, while the setting is on; the counts are this call's own copy. */
  withTokens(repoKey: string, view: FlowStateView): FlowStateView;
  /** Resolves once the change is applied and pushed. */
  setShowing(on: boolean): Promise<void>;
  /** `step`'s counts in `run` as of `closedAt`, whether or not the setting is on. */
  countsAtClose(run: AuditRunId, step: string, closedAt: Date): Promise<StepTokens>;
  dispose(): void;
}

interface Seen {
  steps: string[];
  status: FlowStatus;
  /** The current step's index into `steps`. */
  current: number;
}

const hasRun = (status: FlowStatus): boolean => status === 'in_progress' || status === 'done';

const NOTHING_SWEPT: AgentUsageSweep = { calls: [], problems: [] };

export function createTokenMeter(deps: TokenMeterDeps): TokenMeter {
  const log = deps.log ?? ((message, error): void => console.error(message, error));
  let showing = deps.showing;
  let stop: (() => void) | null = null;
  const seen = new Map<string, Seen>();
  const sweepOf = new Map<string, AgentUsageSweep>();
  const shown = new Map<string, string>();
  // Each repo's place in its agents' logs, so a refresh reads only what they gained.
  const cursorsOf = new Map<string, LogCursors>();
  const cursorsFor = (repoKey: string): LogCursors => {
    let cursors = cursorsOf.get(repoKey);
    if (cursors === undefined) {
      cursors = createLogCursors();
      cursorsOf.set(repoKey, cursors);
    }
    return cursors;
  };
  // The finished flow each repo's counts were last read for: its windows are all closed, so they cannot change.
  const finishedAt = new Map<string, string>();
  const finishedKey = (flow: Seen): string | null => (flow.status === 'in_progress' ? null : JSON.stringify(flow));
  let running: Promise<boolean> | null = null;
  let again = false;

  const tokensFor = (repoKey: string, flow: Seen, sweep: AgentUsageSweep): FlowTokensView => {
    if (!hasRun(flow.status)) return dashTokens(flow.steps);
    const windows = recordedWindows(readCurrentAuditRun(deps.auditRoot, repoKey));
    if (windows === null) return unplacedRunTokens(flow.steps, flow.current, flow.status === 'in_progress');
    return stepTokens(windows, flow.steps, sweep, deps.now());
  };

  const show = (repoKey: string, tokens: FlowTokensView): boolean => {
    const text = JSON.stringify(tokens);
    if (shown.get(repoKey) === text) return false;
    shown.set(repoKey, text);
    return true;
  };

  /** Whether the repo's counts changed. */
  const refreshRepo = async (repoKey: string, flow: Seen): Promise<boolean> => {
    const finished = finishedKey(flow);
    if (finished !== null && finishedAt.get(repoKey) === finished && sweepOf.has(repoKey)) return false;
    const record = hasRun(flow.status) ? readCurrentAuditRun(deps.auditRoot, repoKey) : null;
    const first = record === null ? undefined : recordedWindows(record)?.[0];
    const sweep =
      record === null || first === undefined ? NOTHING_SWEPT : await sweepAgentUsage(deps.logRoots, repoKey, record.agents, Date.parse(first.entered), cursorsFor(repoKey));
    if (!showing) return false;
    sweepOf.set(repoKey, sweep);
    if (finished === null) finishedAt.delete(repoKey);
    else finishedAt.set(repoKey, finished);
    return show(repoKey, tokensFor(repoKey, flow, sweep));
  };

  const refreshAll = (): Promise<boolean> => {
    if (running !== null) {
      again = true;
      return running;
    }
    running = (async () => {
      let changed = false;
      do {
        again = false;
        for (const [repoKey, flow] of seen) {
          try {
            changed = (await refreshRepo(repoKey, flow)) || changed;
          } catch (e: unknown) {
            log('token count refresh failed', e);
          }
        }
      } while (again && showing);
      return changed;
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const refreshAndPush = async (): Promise<void> => {
    if (await refreshAll()) deps.changed();
  };

  const startRefreshing = (): void => {
    stop ??= deps.schedule.start(refreshAndPush);
  };
  if (showing) startRefreshing();

  return {
    withTokens(repoKey, view) {
      if (view.status === 'error') return view;
      const flow: Seen = { steps: [...view.steps], status: view.status, current: view.position - 1 };
      seen.set(repoKey, flow);
      if (!showing) return view;
      const sweep = sweepOf.get(repoKey);
      if (sweep === undefined) {
        void refreshAndPush();
        return { ...view, tokens: dashTokens(flow.steps) };
      }
      try {
        const tokens = tokensFor(repoKey, flow, sweep);
        if (show(repoKey, tokens)) void refreshAndPush();
        return { ...view, tokens };
      } catch (e: unknown) {
        log('token count read failed', e);
        return { ...view, tokens: unplacedRunTokens(flow.steps, flow.current, flow.status === 'in_progress') };
      }
    },

    async setShowing(on) {
      if (on === showing) return;
      showing = on;
      if (on) {
        startRefreshing();
        await refreshAll();
      } else {
        stop?.();
        stop = null;
        sweepOf.clear();
        shown.clear();
        finishedAt.clear();
      }
      deps.changed();
    },

    async countsAtClose(run, step, closedAt) {
      const record = readAuditRun(deps.auditRoot, run);
      const windows = recordedWindows(record);
      if (windows === null) return { state: 'unavailable' };
      const close = closedAt.getTime();
      const asOfClose = windows.map((v) => ({
        step: v.step,
        entered: v.entered,
        exited: v.exited === null || Date.parse(v.exited) > close ? closedAt.toISOString() : v.exited,
      }));
      const sweep = await sweepAgentUsage(deps.logRoots, run.repoPath, record.agents, Date.parse(windows[0].entered), cursorsFor(run.repoPath));
      return stepTokens(asOfClose, [step], sweep, deps.now()).steps[0] ?? { state: 'unavailable' };
    },

    dispose() {
      stop?.();
      stop = null;
    },
  };
}
