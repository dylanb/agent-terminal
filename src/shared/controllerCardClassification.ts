import type { ControllerTerminal, ControllerWorkStatus } from './ipc';

export type CardStatusClass = 'error' | 'needs-human' | 'working' | 'completed' | 'idle';
export type SummaryLabel = 'errors' | 'need a human' | 'idle' | 'working';

export const ACTIVITY_WORDS: Readonly<Record<ControllerWorkStatus['activity'], string>> = {
  active: 'Working', quiet: 'Idle', unavailable: 'Activity unavailable',
};

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

function conditionStatus(work: ControllerWorkStatus): [string, CardStatusClass] {
  const text = [...(work.error ? ['Flow error'] : []), ...(work.attention ? ['Needs a human'] : []), ACTIVITY_WORDS[work.activity]].join(' · ');
  if (work.activity === 'active') return [text, 'working'];
  return [text, work.error ? 'error' : 'needs-human'];
}

function textAndClass(terminal: ControllerTerminal): [string, CardStatusClass] {
  const work = terminal.work;
  if (terminal.status === 'disconnected') return ['Disconnected', 'error'];
  if (work?.error || work?.attention) return conditionStatus(work);
  if (work?.unavailableReason) return ['Status unavailable', 'needs-human'];
  if (!work) return ['Loading', 'idle'];
  if (work.flow.availability !== 'known' || work.flow.assignment === 'unavailable') return ['Status unknown', 'idle'];
  if (work.flow.assignment === 'unassigned') return ['Unassigned', 'idle'];
  if (work.flow.assignment === 'completed') return ['Completed', 'completed'];
  return [ACTIVITY_WORDS[work.activity], work.activity === 'active' ? 'working' : 'idle'];
}

export function cardStatus(terminal: ControllerTerminal): CardStatus {
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
