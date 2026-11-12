import type { AuditVisit, RunTimeline } from '../shared/audit';
import type { FlowTokensView } from '../shared/ipc';
import { TOKEN_KINDS, runTokens, sumCells, type KindCell, type StepTokens, type TokenKind } from '../shared/tokenCounts';
import type { BilledCall } from './agentUsage/billedCall';
import type { Span } from './agentUsage/fileSpan';
import type { AgentUsageSweep } from './agentUsage/sweep';

export type StepWindow = Pick<AuditVisit, 'step' | 'entered' | 'exited'>;

const UNAVAILABLE: StepTokens = { state: 'unavailable' };

const callCell = (call: BilledCall, kind: TokenKind): KindCell => {
  const n = call.kinds[kind];
  return n === undefined ? { reported: 'none' } : { reported: 'all', n };
};

function counted(calls: BilledCall[]): StepTokens {
  const cell = (kind: TokenKind): KindCell => sumCells(calls.map((call) => callCell(call, kind)));
  return { state: 'counted', billed: calls.length > 0, kinds: Object.fromEntries(TOKEN_KINDS.map((kind) => [kind, cell(kind)])) as Record<TokenKind, KindCell> };
}

/** The windows a run's record places, or `null` when it places none: the run has no recorded start. */
export function recordedWindows(record: Pick<RunTimeline, 'coverage' | 'visits'>): StepWindow[] | null {
  return record.coverage === 'unavailable' || record.visits.length === 0 ? null : record.visits;
}

export function dashTokens(steps: string[]): FlowTokensView {
  return { steps: steps.map(() => null), counting: null, run: null };
}

/** A run with no recorded start places no window, so every step up to the current one (`current`, an index into
 *  `steps`) and the run total read unavailable. */
export function unplacedRunTokens(steps: string[], current: number, counting: boolean): FlowTokensView {
  const perStep = steps.map((_, index): StepTokens | null => (index <= current ? UNAVAILABLE : null));
  return { steps: perStep, counting: counting ? current : null, run: runTokens(perStep.filter((s): s is StepTokens => s !== null)) };
}

/** A call belongs to the window whose open time is at or before it and whose close time is after it; an open window
 *  has no close. An unreadable file's span overlaps a window when each starts no later than the other ends, both ends
 *  included, an open window ending `now`. `steps` are the flow's step names, which `visits` name. */
export function stepTokens(visits: StepWindow[], steps: string[], { calls, problems }: AgentUsageSweep, now: number): FlowTokensView {
  const windows = visits.map((v) => ({ index: steps.indexOf(v.step), from: Date.parse(v.entered), to: v.exited === null ? null : Date.parse(v.exited) }));
  const wholeRun = problems.some((p) => p.problem !== 'unreadable file' || p.span === 'times-unreadable');
  const spans = problems.flatMap((p): Span[] => (p.problem === 'unreadable file' && p.span !== 'times-unreadable' ? [p.span] : []));
  const perStep = steps.map((_, index): StepTokens | null => {
    const own = windows.filter((w) => w.index === index);
    if (own.length === 0) return null;
    if (wholeRun || own.some((w) => spans.some((s) => w.from <= s.to && s.from <= (w.to ?? now)))) return UNAVAILABLE;
    return counted(calls.filter((call) => own.some((w) => w.from <= call.at && (w.to === null || call.at < w.to))));
  });
  const last = visits.at(-1);
  const open = last !== undefined && last.exited === null ? steps.indexOf(last.step) : -1;
  return {
    steps: perStep,
    counting: open === -1 ? null : open,
    run: runTokens(perStep.filter((s): s is StepTokens => s !== null)),
  };
}
