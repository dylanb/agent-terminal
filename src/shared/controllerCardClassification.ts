import type { ControllerWorkStatus } from './ipc';
import type { ControllerDirectoryCard } from './controllerCards';
import { waitingLabel } from './waiting';

export type CardStatusClass = 'error' | 'needs-human' | 'working' | 'completed' | 'idle';
export type SummaryLabel = 'errors' | 'need a human' | 'idle' | 'working';

export const ACTIVITY_WORDS: Readonly<Record<ControllerWorkStatus['activity'], string>> = {
  active: 'Working', quiet: 'Idle', unavailable: 'Activity unavailable', waiting: 'Waiting',
};

/** The activity the controller timeline records: Waiting counts as Working, whatever its program. */
export const TIMELINE_ACTIVITY: Readonly<Record<ControllerWorkStatus['activity'], Exclude<ControllerWorkStatus['activity'], 'waiting'>>> = {
  active: 'active', quiet: 'quiet', unavailable: 'unavailable', waiting: 'active',
};

const WORKING: Readonly<Record<ControllerWorkStatus['activity'], boolean>> = {
  active: true, waiting: true, quiet: false, unavailable: false,
};

export function activityLine(work: Pick<ControllerWorkStatus, 'activity' | 'waiting'>): string {
  const word = ACTIVITY_WORDS[work.activity];
  return work.activity === 'waiting' && work.waiting ? `${word} · ${waitingLabel(work.waiting)}` : word;
}

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
  const loopError = work.loopMessage?.kind === 'error';
  const text = [...(work.error ? ['Flow error'] : []), ...(loopError ? ['Loop error'] : []), ...(work.attention ? ['Needs a human'] : []), ACTIVITY_WORDS[work.activity]].join(' · ');
  if (WORKING[work.activity]) return [text, 'working'];
  return [text, work.error || loopError ? 'error' : 'needs-human'];
}

function textAndClass(card: ControllerDirectoryCard): [string, CardStatusClass] {
  if (card.kind === 'conflict') return ['Duplicate directory', 'error'];
  if (card.kind === 'disconnected') return ['Disconnected', 'error'];
  const work = card.work;
  if (work?.error || work?.loopMessage?.kind === 'error' || work?.attention) return conditionStatus(work);
  if (work?.unavailableReason) return ['Status unavailable', 'needs-human'];
  if (!work) return ['Loading', 'idle'];
  if (work.flow.availability !== 'known' || work.flow.assignment === 'unavailable') return ['Status unknown', 'idle'];
  if (work.flow.assignment === 'unassigned') return ['Unassigned', 'idle'];
  if (work.flow.assignment === 'completed') return ['Completed', 'completed'];
  return [activityLine(work), WORKING[work.activity] ? 'working' : 'idle'];
}

export function cardStatus(card: ControllerDirectoryCard): CardStatus {
  const [text, statusClass] = textAndClass(card);
  return { text, statusClass, summary: SUMMARY_OF[statusClass] };
}

export interface StatusCount {
  label: SummaryLabel;
  statusClass: CardStatusClass;
  count: number;
}

export function statusSummary(cards: readonly ControllerDirectoryCard[]): StatusCount[] {
  const summaries = cards.map(card => cardStatus(card).summary);
  return SUMMARY_LABELS.map(label => ({ label, statusClass: SUMMARY_CLASS[label], count: summaries.filter(summary => summary === label).length }));
}

export interface CardCounts {
  total: number;
  connected: number;
  disconnected: number;
}

export function cardCounts(cards: readonly ControllerDirectoryCard[]): CardCounts {
  const disconnected = cards.filter(card => card.kind === 'disconnected').length;
  return { total: cards.length, connected: cards.length - disconnected, disconnected };
}
