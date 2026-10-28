import { CONTROLLER_OVERSIZED_STATUS_TEXT } from './controllerStatus';
import type { ControllerWorkStatus } from './ipc';
import type { ControllerDirectoryCard } from './controllerCards';

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

function textAndClass(card: ControllerDirectoryCard): [string, CardStatusClass] {
  if (card.kind === 'conflict') return ['Duplicate directory', 'error'];
  if (card.kind === 'disconnected') return ['Disconnected', 'error'];
  const work = card.work;
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

export function attentionText(work: ControllerWorkStatus | undefined): string {
  if (work?.unavailableReason) return CONTROLLER_OVERSIZED_STATUS_TEXT;
  return workConditions(work).flatMap(condition => [condition.title, ...condition.reasons]).join('. ');
}

export function attentionUpdate(previous: string, current: string): string | undefined {
  if (current === previous) return undefined;
  if (current) return current;
  return previous === CONTROLLER_OVERSIZED_STATUS_TEXT ? 'Status available: no attention or error reported' : 'Attention and error cleared';
}

export interface CardCounts {
  total: number;
  connected: number;
  disconnected: number;
}

export function cardCounts(_cards: readonly ControllerDirectoryCard[]): CardCounts {
  return { total: 0, connected: 0, disconnected: 0 };
}
