import { SUMMARY_LABELS, cardStatus, type SummaryLabel } from '../../shared/controllerCardClassification';
import type { ControllerDirectoryCard } from '../../shared/controllerCards';
import type { ControllerSortMode } from '../../shared/ipc';

interface Observation {
  readonly group: SummaryLabel;
  readonly disconnected: boolean;
  readonly enteredAt: number;
  readonly seen: number;
}

const OBSERVED = Symbol('card observations');
export interface CardObservations {
  readonly [OBSERVED]: { readonly byDirectory: ReadonlyMap<string, Observation>; readonly nextSeen: number };
}

export type CardListEntry =
  | { readonly kind: 'heading'; readonly name: string; readonly group?: SummaryLabel; readonly count?: number }
  | { readonly kind: 'card'; readonly card: ControllerDirectoryCard };

const RECENTLY_USED_HEADING = 'Recently used';

const GROUP_HEADINGS: Readonly<Record<SummaryLabel, string>> = {
  errors: 'Errors', 'need a human': 'Needs a human', idle: 'Idle & unassigned', working: 'Working',
};

const TIME_VERBS: Readonly<Record<SummaryLabel, string>> = {
  errors: 'for', 'need a human': 'waiting', idle: 'for', working: 'running',
};

export function observeCards(previous: CardObservations | undefined, cards: readonly ControllerDirectoryCard[], now: number): CardObservations {
  const before = previous?.[OBSERVED].byDirectory;
  let nextSeen = previous?.[OBSERVED].nextSeen ?? 0;
  const byDirectory = new Map<string, Observation>();
  for (const card of cards) {
    const group = cardStatus(card).summary;
    const disconnected = card.kind === 'disconnected';
    const last = before?.get(card.launchDirectory);
    const restarted = !last || last.group !== group || (last.disconnected && !disconnected);
    byDirectory.set(card.launchDirectory, {
      group,
      disconnected,
      enteredAt: restarted ? now : last.enteredAt,
      seen: last?.seen ?? nextSeen++,
    });
  }
  return { [OBSERVED]: { byDirectory, nextSeen } };
}

function observationOf(card: ControllerDirectoryCard, observations: CardObservations): Observation {
  const observation = observations[OBSERVED].byDirectory.get(card.launchDirectory);
  if (!observation) throw new Error(`The card for ${card.launchDirectory} was not observed`);
  return observation;
}

/** Each used launch directory's latest recency interaction, a higher number for a later one. */
export type CardRecency = ReadonlyMap<string, number>;

export function cardList(cards: readonly ControllerDirectoryCard[], observations: CardObservations, sortMode: ControllerSortMode, recency: CardRecency): CardListEntry[] {
  const observed = cards.map(card => ({ card, observation: observationOf(card, observations) }));
  const groups = SUMMARY_LABELS.map(group => ({
    group,
    members: observed
      .filter(({ observation }) => observation.group === group)
      .sort((a, b) => a.observation.enteredAt - b.observation.enteredAt || a.observation.seen - b.observation.seen)
      .map(({ card }) => card),
  })).filter(({ members }) => members.length);
  const entry = (card: ControllerDirectoryCard): CardListEntry => ({ kind: 'card', card });
  if (sortMode === 'recently-used') {
    if (!groups.length) return [];
    const attention = groups.flatMap(({ members }) => members);
    const used = attention.filter(card => recency.has(card.launchDirectory))
      .sort((a, b) => recency.get(b.launchDirectory)! - recency.get(a.launchDirectory)!);
    const untouched = attention.filter(card => !recency.has(card.launchDirectory));
    return [{ kind: 'heading', name: RECENTLY_USED_HEADING }, ...[...used, ...untouched].map(entry)];
  }
  return groups.flatMap(({ group, members }): CardListEntry[] => [{ kind: 'heading', name: GROUP_HEADINGS[group], group, count: members.length }, ...members.map(entry)]);
}

/** `shown` kept in place: each card updated or dropped, each group heading recounted (0 once its group is empty), and
 *  every card not yet shown added at the end, in the order `cardList` gives them. */
export function frozenCardList(shown: readonly CardListEntry[], cards: readonly ControllerDirectoryCard[], observations: CardObservations, sortMode: ControllerSortMode, recency: CardRecency): CardListEntry[] {
  const current = new Map(cards.map(card => [card.launchDirectory, card]));
  const counts = new Map<SummaryLabel, number>();
  for (const card of cards) {
    const { group } = observationOf(card, observations);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  const kept = shown.flatMap((entry): CardListEntry[] => {
    if (entry.kind === 'heading') return [entry.group ? { ...entry, count: counts.get(entry.group) ?? 0 } : entry];
    const card = current.get(entry.card.launchDirectory);
    return card ? [{ kind: 'card', card }] : [];
  });
  const placed = new Set(kept.flatMap(entry => (entry.kind === 'card' ? [entry.card.launchDirectory] : [])));
  const arrivals = cardList(cards, observations, sortMode, recency).filter(entry => entry.kind === 'card' && !placed.has(entry.card.launchDirectory));
  return [...kept, ...arrivals];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function durationText(elapsed: number): string {
  if (elapsed < MINUTE) return 'under 1m';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ${Math.floor((elapsed % HOUR) / MINUTE)}m`;
  return `${Math.floor(elapsed / DAY)}d ${Math.floor((elapsed % DAY) / HOUR)}h`;
}

export function timeInStateText(card: ControllerDirectoryCard, observations: CardObservations, now: number): string {
  const { group, enteredAt } = observationOf(card, observations);
  return `${TIME_VERBS[group]} ${durationText(Math.max(0, now - enteredAt))}`;
}
