import type { ControllerTerminal } from './ipc';

export type CardStatusClass = 'error' | 'needs-human' | 'working' | 'completed' | 'idle';
export type SummaryLabel = 'errors' | 'need a human' | 'idle' | 'working';

export const SUMMARY_LABELS: readonly SummaryLabel[] = ['errors', 'need a human', 'idle', 'working'];

export const SUMMARY_CLASS: Readonly<Record<SummaryLabel, CardStatusClass>> = {
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

function textAndClass(terminal: ControllerTerminal): [string, CardStatusClass] {
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

export function cardStatus(terminal: ControllerTerminal): CardStatus {
  const [text, statusClass] = textAndClass(terminal);
  return { text, statusClass, summary: SUMMARY_OF[statusClass] };
}
