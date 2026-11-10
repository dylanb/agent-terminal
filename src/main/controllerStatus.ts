import type { ControllerLoopMessage, ControllerWorkStatus, FlowStateView } from '../shared/ipc';
import type { ControllerActivity } from '../shared/waiting';
import { isControllerIssueNumber } from '../shared/controllerStatus';
import { statusBarTitleText, titleOf } from '../shared/statusBar';
import { errMsg } from './errno';
import { APP_LOOP_STATUS_ERROR } from './loopViewV2';
import { publishedLoopReason } from './loopMessages';

export interface ControllerStatusSource {
  current(): {
    repoKey: string;
    flowName: string | null;
    activity: ControllerActivity;
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

type TitleState = Extract<ControllerWorkStatus['ticket'], { availability: 'known' }>['title'];

function createLatestRead<T>(what: string, initial: T, failed: T, settled: () => void) {
  let entry: { key: string; value: T; pending: boolean; failure?: string } | undefined;
  return {
    value(key: string, read: (() => Promise<T>) | undefined, again = false): T {
      const fresh = entry?.key !== key;
      if (fresh) entry = { key, value: initial, pending: false };
      const owner = entry!;
      if (read && (fresh || again) && !owner.pending) {
        owner.pending = true;
        const reading = (): Promise<T> => {
          try { return read(); } catch (error) { return Promise.reject(error); }
        };
        void reading().then(result => {
          delete owner.failure;
          return result;
        }, (error: unknown) => {
          const failure = errMsg(error);
          if (owner.failure !== failure) console.error(`Controller ${what} not read: ${failure}`);
          owner.failure = failure;
          return failed;
        }).then(result => {
          owner.pending = false;
          owner.value = result;
          settled();
        });
      }
      return owner.value;
    },
    forget() { entry = undefined; },
  };
}

export function createControllerStatus(source: ControllerStatusSource, { branchRefreshMs }: { branchRefreshMs: number }): {
  refresh(): void;
  /** Each delivery is a detached value owned by the subscriber. */
  subscribe(listener: (work: ControllerWorkStatus) => void): () => void;
  dispose(): void;
} {
  const listeners = new Set<(work: ControllerWorkStatus) => void>();
  let work: ControllerWorkStatus = {
    flow: { availability: 'loading' }, ticket: { availability: 'loading' }, activity: 'unavailable', attention: null, error: null,
  };
  let alive = true;
  const settled = () => refresh();
  const ticketTitle = createLatestRead<TitleState>('ticket title', { availability: 'loading' }, { availability: 'unavailable' }, settled);
  const prTitle = createLatestRead<TitleState>('pull request title', { availability: 'loading' }, { availability: 'unavailable' }, settled);
  const branch = createLatestRead<string | null>('branch', null, null, settled);
  let previous = '';
  let previousRefresh: { position: string; loopStatus: string | undefined; messageId: string | undefined } | undefined;
  let turnErrorId: string | undefined;
  let withdrawnErrorId: string | undefined;
  const publish = () => {
    const serialized = JSON.stringify(work);
    if (serialized === previous) return;
    previous = serialized;
    for (const listener of listeners) {
      try {
        listener(structuredClone(work));
      } catch (error) {
        console.error(`Controller status not delivered: ${errMsg(error)}`);
      }
    }
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
      const titleRead = (kind: 'issue' | 'pr', refNumber: number | undefined) => refNumber === undefined ? undefined
        : () => source.refTitle(repoKey, kind, refNumber).then((text): TitleState => text !== null ? { availability: 'known', text } : { availability: 'unavailable' });
      const ticketTitleState = ticketTitle.value(JSON.stringify([repoKey, number]), titleRead('issue', number));
      const prTitleState = prTitle.value(JSON.stringify([repoKey, prNumber]), titleRead('pr', prNumber));
      const branchLabel = branch.value(repoKey, () => source.branch(repoKey), readBranch);
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
      const titleState = titleKind.kind === 'pr' ? prTitleState : titleKind.kind === 'ticket' ? ticketTitleState : undefined;
      const known = flowName !== null && view.status !== 'error';
      work = {
        flow: known ? {
          availability: 'known', name: flowName, step: view.stepName,
          assignment: view.runStarted === 'indeterminate' ? 'unavailable' : view.runStarted === 'never-started' ? 'unassigned' : view.status === 'done' ? 'completed' : 'assigned',
        } : { availability: 'unavailable' },
        ticket: number !== undefined ? { availability: 'known', number, title: ticketTitleState } : { availability: known && view.runStarted !== 'indeterminate' && !invalidTicket ? 'none' : 'unavailable' },
        ...activity,
        attention: loop?.humanNeeded ? { status: loop.status, reasons: [...new Set(reasons)] } : null,
        error: error ? { reason: error } : null,
        loopMessage: shownMessage,
        title: statusBarTitleText(titleKind, titleState?.availability === 'known' ? titleState.text : null),
        branch: branchLabel,
      };
      publish();
    } catch (error) {
      ticketTitle.forget();
      prTitle.forget();
      work = { flow: { availability: 'unavailable' }, ticket: { availability: 'unavailable' }, activity: 'unavailable', attention: null, error: { reason: errMsg(error) } };
      publish();
    }
  };
  const branchTimer = setInterval(() => refresh(true), branchRefreshMs);
  branchTimer.unref?.();
  return {
    refresh: () => refresh(),
    subscribe(listener) { listeners.add(listener); listener(structuredClone(work)); return () => { listeners.delete(listener); }; },
    dispose() { alive = false; clearInterval(branchTimer); listeners.clear(); ticketTitle.forget(); prTitle.forget(); branch.forget(); },
  };
}
