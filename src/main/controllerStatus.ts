import type { AgentState, ControllerLoopMessage, ControllerWorkStatus, FlowStateView } from '../shared/ipc';
import { isControllerIssueNumber } from '../shared/controllerStatus';
import { errMsg } from './errno';

export interface ControllerStatusSource {
  current(): {
    repoKey: string;
    flowName: string | null;
    activity: AgentState;
    loopMessage: ControllerLoopMessage | null;
    view: Pick<FlowStateView, 'stepName' | 'status' | 'runStarted' | 'error'> & {
      refs?: { ticket?: number };
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
  issueTitle(repoKey: string, number: number): Promise<string | null>;
}

export function createControllerStatus(source: ControllerStatusSource): {
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
  let occurrence: { repoKey: string; number: number | undefined; title: Extract<ControllerWorkStatus['ticket'], { availability: 'known' }>['title'] } | undefined;
  let previous = '';
  const publish = () => {
    const serialized = JSON.stringify(work);
    if (serialized === previous) return;
    previous = serialized;
    for (const listener of listeners) listener(structuredClone(work));
  };
  const refresh = () => {
    if (!alive) return;
    try {
      const { repoKey, flowName, view, activity, loopMessage } = source.current();
      const rawNumber = view.refs?.ticket;
      const invalidTicket = rawNumber !== undefined && !isControllerIssueNumber(rawNumber);
      const number = isControllerIssueNumber(rawNumber) ? rawNumber : undefined;
      let fetchTitle = false;
      if (!occurrence || occurrence.repoKey !== repoKey || occurrence.number !== number) {
        occurrence = { repoKey, number, title: { availability: 'loading' } };
        fetchTitle = number !== undefined;
      }
      const loop = view.loop;
      const reasons = [loop?.errorReason, loop?.verdictReason, ...(loop?.autoGate?.haltReasons.map(halt => halt.detail ?? halt.reason) ?? []), loop?.autoGate?.failedEffect?.detail].filter((reason): reason is string => Boolean(reason));
      const error = view.error ?? loop?.errorReason;
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
        loopMessage,
      };
      publish();
      if (fetchTitle && number !== undefined) {
        const owner = occurrence;
        void source.issueTitle(repoKey, number).catch(() => null).then(result => {
          if (!alive || occurrence !== owner) return;
          owner.title = result !== null ? { availability: 'known', text: result } : { availability: 'unavailable' };
          refresh();
        });
      }
    } catch (error) {
      occurrence = undefined;
      work = { flow: { availability: 'unavailable' }, ticket: { availability: 'unavailable' }, activity: 'unavailable', attention: null, error: { reason: errMsg(error) } };
      publish();
    }
  };
  return {
    refresh,
    subscribe(listener) { listeners.add(listener); listener(structuredClone(work)); return () => { listeners.delete(listener); }; },
    dispose() { alive = false; listeners.clear(); occurrence = undefined; },
  };
}
