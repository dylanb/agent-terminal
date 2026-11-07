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
  | { readonly kind: 'heading'; readonly name: string; readonly count: number }
  | { readonly kind: 'card'; readonly card: ControllerDirectoryCard };

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

export function cardList(cards: readonly ControllerDirectoryCard[], observations: CardObservations, _sortMode: ControllerSortMode): CardListEntry[] {
  const observed = cards.map(card => ({ card, observation: observationOf(card, observations) }));
  return SUMMARY_LABELS.flatMap((group): CardListEntry[] => {
    const members = observed
      .filter(({ observation }) => observation.group === group)
      .sort((a, b) => a.observation.enteredAt - b.observation.enteredAt || a.observation.seen - b.observation.seen);
    if (!members.length) return [];
    return [{ kind: 'heading', name: GROUP_HEADINGS[group], count: members.length }, ...members.map(({ card }) => ({ kind: 'card' as const, card }))];
  });
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
