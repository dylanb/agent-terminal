import type { AgentState, ControllerLoopMessage, ControllerWorkStatus, FlowStateView } from '../shared/ipc';
import { isControllerIssueNumber } from '../shared/controllerStatus';
import { statusBarTitleText, titleOf } from '../shared/statusBar';
import { errMsg } from './errno';
import { APP_LOOP_STATUS_ERROR } from './loopViewV2';
import { publishedLoopReason } from './loopMessages';

export interface ControllerStatusSource {
  current(): {
    repoKey: string;
    flowName: string | null;
    activity: AgentState;
    loopMessage: ControllerLoopMessage | null;
    view: Pick<FlowStateView, 'stepName' | 'status' | 'runStarted' | 'error'> & {
      refs?: { ticket?: number; pr?: number };
      userTitle?: string;
      loop?: {
        status: string;
        humanNeeded?: boolean;
        errorReason?: string;
        verdictReason?: string;
        autoGate?: {
          haltReasons: readonly { reason: string; detail?: string }[];
          failedEffect?: { detail: string };
        };
      };
    };
  };
  refTitle(repoKey: string, kind: 'issue' | 'pr', number: number): Promise<string | null>;
  branch(repoKey: string): Promise<string | null>;
}

export const CONTROLLER_BRANCH_REFRESH_MS = 1_000;

export function createControllerStatus(source: ControllerStatusSource): {
  refresh(): void;
  refreshBranch(): void;
  /** Each delivery is a detached value owned by the subscriber. */
  subscribe(listener: (work: ControllerWorkStatus) => void): () => void;
  dispose(): void;
} {
  const listeners = new Set<(work: ControllerWorkStatus) => void>();
  let work: ControllerWorkStatus = {
    flow: { availability: 'loading' }, ticket: { availability: 'loading' }, activity: 'unavailable', attention: null, error: null,
  };
  let alive = true;
  type RefOccurrence = { repoKey: string; number: number | undefined; title: Extract<ControllerWorkStatus['ticket'], { availability: 'known' }>['title'] };
  let occurrence: RefOccurrence | undefined;
  let prOccurrence: RefOccurrence | undefined;
  let branchRead: { repoKey: string; pending: boolean; label: string | null } | undefined;
  let previous = '';
  let previousRefresh: { position: string; loopStatus: string | undefined; messageId: string | undefined } | undefined;
  let turnErrorId: string | undefined;
  let withdrawnErrorId: string | undefined;
  const publish = () => {
    const serialized = JSON.stringify(work);
    if (serialized === previous) return;
    previous = serialized;
    for (const listener of listeners) listener(structuredClone(work));
  };
  const refresh = (readBranch = false) => {
    if (!alive) return;
    try {
      const { repoKey, flowName, view, activity, loopMessage } = source.current();
      const rawNumber = view.refs?.ticket;
      const invalidTicket = rawNumber !== undefined && !isControllerIssueNumber(rawNumber);
      const number = isControllerIssueNumber(rawNumber) ? rawNumber : undefined;
      const rawPr = view.refs?.pr;
      const prNumber = isControllerIssueNumber(rawPr) ? rawPr : undefined;
      let fetchTitle = false;
      let fetchPrTitle = false;
      if (!occurrence || occurrence.repoKey !== repoKey || occurrence.number !== number) {
        occurrence = { repoKey, number, title: { availability: 'loading' } };
        fetchTitle = number !== undefined;
      }
      if (!prOccurrence || prOccurrence.repoKey !== repoKey || prOccurrence.number !== prNumber) {
        prOccurrence = { repoKey, number: prNumber, title: { availability: 'loading' } };
        fetchPrTitle = prNumber !== undefined;
      }
      const sameRepository = branchRead?.repoKey === repoKey;
      const shownBranch = sameRepository && branchRead ? branchRead : { repoKey, pending: false, label: null };
      branchRead = shownBranch;
      const startBranchRead = (!sameRepository || readBranch) && !shownBranch.pending;
      const loop = view.loop;
      const reasons = [loop?.errorReason, loop?.verdictReason, ...(loop?.autoGate?.haltReasons.map(halt => halt.detail ?? halt.reason) ?? []), loop?.autoGate?.failedEffect?.detail].filter((reason): reason is string => Boolean(reason));
      const error = view.error ?? loop?.errorReason;
      const position = JSON.stringify([repoKey, view.stepName]);
      const loopInError = loop?.status === APP_LOOP_STATUS_ERROR;
      const movedOn = previousRefresh !== undefined
        && (previousRefresh.position !== position || (previousRefresh.loopStatus === APP_LOOP_STATUS_ERROR && !loopInError));
      if (movedOn && turnErrorId !== undefined) withdrawnErrorId = turnErrorId;
      if (loopMessage?.id !== previousRefresh?.messageId) turnErrorId = loopMessage?.kind === 'error' && loopInError && loop?.errorReason !== undefined && loopMessage.reason === publishedLoopReason(loop.errorReason) ? loopMessage.id : undefined;
      const shownMessage = loopMessage !== null && loopMessage.id === withdrawnErrorId ? null : loopMessage;
      previousRefresh = { position, loopStatus: loop?.status, messageId: loopMessage?.id };
      const titleKind = titleOf(view);
      const titleOccurrence = titleKind.kind === 'pr' ? prOccurrence : titleKind.kind === 'ticket' ? occurrence : undefined;
      const known = flowName !== null && view.status !== 'error';
      work = {
        flow: known ? {
          availability: 'known', name: flowName, step: view.stepName,
          assignment: view.runStarted === 'indeterminate' ? 'unavailable' : view.runStarted === 'never-started' ? 'unassigned' : view.status === 'done' ? 'completed' : 'assigned',
        } : { availability: 'unavailable' },
        ticket: number !== undefined ? { availability: 'known', number, title: occurrence.title } : { availability: known && view.runStarted !== 'indeterminate' && !invalidTicket ? 'none' : 'unavailable' },
        activity,
        attention: loop?.humanNeeded ? { status: loop.status, reasons: [...new Set(reasons)] } : null,
        error: error ? { reason: error } : null,
        loopMessage: shownMessage,
        title: statusBarTitleText(titleKind, titleOccurrence?.title.availability === 'known' ? titleOccurrence.title.text : null),
        branch: shownBranch.label,
      };
      publish();
      const fetchRef = (owner: RefOccurrence, kind: 'issue' | 'pr', refNumber: number, current: () => RefOccurrence | undefined) => {
        void source.refTitle(repoKey, kind, refNumber).catch(() => null).then(result => {
          if (!alive || current() !== owner) return;
          owner.title = result !== null ? { availability: 'known', text: result } : { availability: 'unavailable' };
          refresh();
        });
      };
      if (fetchTitle && number !== undefined) fetchRef(occurrence, 'issue', number, () => occurrence);
      if (fetchPrTitle && prNumber !== undefined) fetchRef(prOccurrence, 'pr', prNumber, () => prOccurrence);
      if (startBranchRead) {
        const read = shownBranch;
        read.pending = true;
        void Promise.resolve().then(() => source.branch(repoKey)).catch(() => null).then(label => {
          read.pending = false;
          if (!alive || branchRead !== read) return;
          read.label = label;
          refresh();
        });
      }
    } catch (error) {
      occurrence = undefined;
      prOccurrence = undefined;
      work = { flow: { availability: 'unavailable' }, ticket: { availability: 'unavailable' }, activity: 'unavailable', attention: null, error: { reason: errMsg(error) } };
      publish();
    }
  };
  return {
    refresh: () => refresh(),
    refreshBranch: () => refresh(true),
    subscribe(listener) { listeners.add(listener); listener(structuredClone(work)); return () => { listeners.delete(listener); }; },
    dispose() { alive = false; listeners.clear(); occurrence = undefined; prOccurrence = undefined; branchRead = undefined; },
  };
}
