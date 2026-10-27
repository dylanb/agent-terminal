import { CONTROLLER_OVERSIZED_STATUS_TEXT } from '../../shared/controllerStatus';
import type { ControllerTerminal, ControllerWorkStatus } from '../../shared/ipc';

export type CardStatusClass = 'error' | 'needs-human' | 'working' | 'completed' | 'idle';
type SummaryLabel = 'errors' | 'need a human' | 'idle' | 'working';

const SUMMARY_LABELS: readonly SummaryLabel[] = ['errors', 'need a human', 'idle', 'working'];

const SUMMARY_CLASS: Readonly<Record<SummaryLabel, CardStatusClass>> = {
  errors: 'error', 'need a human': 'needs-human', idle: 'idle', working: 'working',
};

const SUMMARY_OF: Readonly<Record<CardStatusClass, SummaryLabel>> = {
  error: 'errors', 'needs-human': 'need a human', working: 'working', completed: 'idle', idle: 'idle',
};

export interface CardStatus {
  text: string;
  statusClass: CardStatusClass;
  summary: SummaryLabel;
}

function textAndClass(terminal: ControllerTerminal & { instanceCount?: number }): [string, CardStatusClass] {
  if ((terminal.instanceCount ?? 1) > 1) return ['Duplicate directory', 'error'];
  const work = terminal.work;
  if (terminal.status === 'disconnected') return ['Disconnected', 'error'];
  if (work?.error) return ['Flow error', 'error'];
  if (work?.attention) return ['Needs a human', 'needs-human'];
  if (work?.unavailableReason) return ['Status unavailable', 'needs-human'];
  if (!work) return ['Loading', 'idle'];
  if (work.flow.availability !== 'known' || work.flow.assignment === 'unavailable') return ['Status unknown', 'idle'];
  if (work.flow.assignment === 'unassigned') return ['Unassigned', 'idle'];
  if (work.flow.assignment === 'completed') return ['Completed', 'completed'];
  if (work.activity === 'quiet') return ['Idle', 'idle'];
  return ['Working', 'working'];
}

export function cardStatus(terminal: ControllerTerminal & { instanceCount?: number }): CardStatus {
  const [text, statusClass] = textAndClass(terminal);
  return { text, statusClass, summary: SUMMARY_OF[statusClass] };
}

export interface StatusCount {
  label: SummaryLabel;
  statusClass: CardStatusClass;
  count: number;
}

export function statusSummary(terminals: readonly ControllerTerminal[]): StatusCount[] {
  const summaries = terminals.map(terminal => cardStatus(terminal).summary);
  return SUMMARY_LABELS.map(label => ({ label, statusClass: SUMMARY_CLASS[label], count: summaries.filter(summary => summary === label).length }));
}

export interface WorkCondition {
  statusClass: 'needs-human' | 'error';
  title: string;
  reasons: readonly string[];
}

export function workConditions(work: ControllerWorkStatus | undefined): WorkCondition[] {
  return [
    ...(work?.attention ? [{ statusClass: 'needs-human' as const, title: `Human needed: ${work.attention.status}`, reasons: work.attention.reasons }] : []),
    ...(work?.error ? [{ statusClass: 'error' as const, title: 'Error', reasons: [work.error.reason] }] : []),
  ];
}

export function attentionText(terminal: ControllerTerminal): string {
  if (terminal.work?.unavailableReason) return CONTROLLER_OVERSIZED_STATUS_TEXT;
  return workConditions(terminal.work).flatMap(condition => [condition.title, ...condition.reasons]).join('. ');
}

export function attentionUpdate(previous: string, current: string): string | undefined {
  if (current === previous) return undefined;
  if (current) return current;
  return previous === CONTROLLER_OVERSIZED_STATUS_TEXT ? 'Status available: no attention or error reported' : 'Attention and error cleared';
}
