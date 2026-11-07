import type { ControllerTerminal } from '../../src/shared/ipc';
import { STATUS_CASES, type SortMode, type StatusCaseKey, type SummaryLabel } from './controllerStatusFixture';

/** The `STATUS_CASES` terminal for `status`, moved to a launch directory of its own (`/order/<name>/worktree`), so a
 *  test can put several cards in one status group and tell each apart by directory. */
export function orderTerminal(name: string, status: StatusCaseKey): ControllerTerminal {
  return {
    ...STATUS_CASES[status].terminal,
    id: `order-${name}`,
    launchDirectory: `/order/${name}/worktree`,
    repositoryRoot: `/order/${name}`,
  };
}

/** The directory `orderTerminal(name, …)` launches in. */
export const orderDirectory = (name: string): string => `/order/${name}/worktree`;

/** The heading the ticket gives each status group, keyed by the window header's summary label, in group order. */
export const GROUP_HEADINGS: Readonly<Record<SummaryLabel, string>> = {
  errors: 'Errors', 'need a human': 'Needs a human', idle: 'Idle & unassigned', working: 'Working',
};
/** A heading as the list read shows it: its name, then its count. */
export const heading = (summary: SummaryLabel, count: number): string => `${GROUP_HEADINGS[summary]} ${count}`;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Time in state, in ms, and the duration text it reads as: whole units rounded down, each boundary and either side of it. */
export const DURATION_TEXTS: ReadonlyArray<readonly [number, string]> = [
  [0, 'under 1m'],
  [59_999, 'under 1m'],
  [MINUTE, '1m'],
  [MINUTE + 59_999, '1m'],
  [59 * MINUTE + 59_999, '59m'],
  [HOUR, '1h 0m'],
  [2 * HOUR + 5 * MINUTE + 30_000, '2h 5m'],
  [23 * HOUR + 59 * MINUTE + 59_999, '23h 59m'],
  [DAY, '1d 0h'],
  [DAY + 23 * HOUR + 59 * MINUTE, '1d 23h'],
  [3 * DAY + 4 * HOUR + 7 * MINUTE, '3d 4h'],
];

/** The verb each status group's time in state reads with, by a status case in that group. */
export const TIME_VERBS: ReadonlyArray<readonly [StatusCaseKey, string]> = [
  ['needs-human', 'waiting'],
  ['needs-human-working', 'running'],
  ['working', 'running'],
  ['flow-error', 'for'],
  ['disconnected', 'for'],
  ['idle', 'for'],
  ['completed', 'for'],
];

/** One snapshot the controller sees, `at` ms after the first. */
export interface OrderStep { at: number; terminals: ControllerTerminal[] }
/** Snapshots in the order the controller sees them, and the Attention list after the last: headings as
 *  `heading(…)` reads them, cards as their launch directories. */
export interface OrderExample { steps: OrderStep[]; list: string[] }

const t = orderTerminal;
const d = orderDirectory;
/** A second live terminal in `name`'s directory, which makes it a duplicate-directory card. */
export const orderPeer = (name: string, status: StatusCaseKey): ControllerTerminal => ({ ...orderTerminal(name, status), id: `order-${name}-peer` });

export const ORDER_EXAMPLES: Readonly<Record<string, OrderExample>> = {
  'cards in all four groups, each group a different size, all seen at once, keep registration order within a group': {
    steps: [{ at: 0, terminals: [
      t('w1', 'working'), t('i1', 'idle'), t('e1', 'flow-error'), t('h1', 'needs-human'), t('i2', 'unassigned'),
      t('w2', 'needs-human-working'), t('e2', 'disconnected'), t('i3', 'completed'), t('e3', 'loop-error'), t('i4', 'loading'),
    ] }],
    list: [
      heading('errors', 3), d('e1'), d('e2'), d('e3'),
      heading('need a human', 1), d('h1'),
      heading('idle', 4), d('i1'), d('i2'), d('i3'), d('i4'),
      heading('working', 2), d('w1'), d('w2'),
    ],
  },
  'a group with no cards has no heading': {
    steps: [{ at: 0, terminals: [t('w1', 'working'), t('e1', 'flow-error'), t('w2', 'working'), t('i1', 'idle'), t('e2', 'flow-error'), t('w3', 'working')] }],
    list: [heading('errors', 2), d('e1'), d('e2'), heading('idle', 1), d('i1'), heading('working', 3), d('w1'), d('w2'), d('w3')],
  },
  'disconnected, duplicate-directory and flow-error cards are Errors; Needs a human · Working is Working; Completed is Idle & unassigned': {
    steps: [{ at: 0, terminals: [
      t('completed', 'completed'), t('gate-working', 'needs-human-working'), t('dup', 'idle'), orderPeer('dup', 'idle'),
      t('gone', 'disconnected'), t('failed', 'flow-error'), t('busy', 'working'),
    ] }],
    list: [heading('errors', 3), d('dup'), d('gone'), d('failed'), heading('idle', 1), d('completed'), heading('working', 2), d('gate-working'), d('busy')],
  },
  'the card longer in its group comes first, though it registered later; equal times keep registration order': {
    steps: [
      { at: 0, terminals: [t('a', 'idle'), t('b', 'flow-error')] },
      { at: 5 * MINUTE, terminals: [t('a', 'flow-error'), t('b', 'flow-error'), t('c', 'flow-error')] },
    ],
    list: [heading('errors', 3), d('b'), d('a'), d('c')],
  },
  'registration order is the order the controller first saw each directory, not the latest snapshot order': {
    steps: [
      { at: 0, terminals: [t('x', 'idle'), t('y', 'idle')] },
      { at: MINUTE, terminals: [t('y', 'idle'), t('x', 'idle')] },
    ],
    list: [heading('idle', 2), d('x'), d('y')],
  },
  'a directory that leaves the snapshot and registers again is seen anew': {
    steps: [
      { at: 0, terminals: [t('x', 'idle'), t('y', 'idle')] },
      { at: MINUTE, terminals: [t('y', 'working')] },
      { at: 2 * MINUTE, terminals: [t('x', 'idle'), t('y', 'idle')] },
    ],
    list: [heading('idle', 2), d('y'), d('x')],
  },
  'a card that changes group goes after the cards already in its new group': {
    steps: [
      { at: 0, terminals: [t('a', 'idle'), t('b', 'needs-human'), t('c', 'needs-human')] },
      { at: 10 * MINUTE, terminals: [t('a', 'needs-human'), t('b', 'needs-human'), t('c', 'needs-human')] },
    ],
    list: [heading('need a human', 3), d('b'), d('c'), d('a')],
  },
  'a change that keeps a card in its group keeps its time in state': {
    steps: [
      { at: 0, terminals: [t('b', 'idle'), t('a', 'flow-error')] },
      { at: MINUTE, terminals: [t('b', 'loop-error'), t('a', 'flow-error')] },
      { at: 2 * MINUTE, terminals: [t('b', 'loop-error'), t('a', 'flow-error'), orderPeer('a', 'flow-error')] },
    ],
    list: [heading('errors', 2), d('a'), d('b')],
  },
  'a disconnected card whose terminal registers again restarts its time in state, though it stays in Errors': {
    steps: [
      { at: 0, terminals: [t('x', 'disconnected'), t('y', 'idle')] },
      { at: MINUTE, terminals: [t('x', 'disconnected'), t('y', 'flow-error')] },
      { at: 2 * MINUTE, terminals: [t('x', 'flow-error'), t('y', 'flow-error')] },
    ],
    list: [heading('errors', 2), d('y'), d('x')],
  },
  'a card that stays disconnected keeps its time in state': {
    steps: [
      { at: 0, terminals: [t('x', 'disconnected'), t('y', 'idle')] },
      { at: MINUTE, terminals: [t('x', 'disconnected'), t('y', 'flow-error')] },
      { at: 2 * MINUTE, terminals: [t('x', 'disconnected'), t('y', 'flow-error')] },
    ],
    list: [heading('errors', 2), d('x'), d('y')],
  },
  'an Errors card that disconnects keeps its time in state': {
    steps: [
      { at: 0, terminals: [t('x', 'flow-error')] },
      { at: MINUTE, terminals: [t('x', 'flow-error'), t('y', 'flow-error')] },
      { at: 2 * MINUTE, terminals: [t('x', 'disconnected'), t('y', 'flow-error')] },
    ],
    list: [heading('errors', 2), d('x'), d('y')],
  },
};

/** The heading Recently used order shows above every card, read as the list helper reads it: no count. */
export const RECENTLY_USED_HEADING = 'Recently used';

/** The sentence beneath the window header for each order, in the ticket's words (AC 9). */
export const SORT_SENTENCES: Readonly<Record<SortMode, string>> = {
  attention: 'Sorted by attention: errors first, then needs a human, idle & unassigned, and working, each longest in its state first.',
  'recently-used': 'Sorted by your most recent use of each card in this controller; cards you have not used yet follow in attention order.',
};

/** Snapshots, as in `ORDER_EXAMPLES`, and the Recently used list after the last when no card has been used yet. */
export const RECENT_EXAMPLES: Readonly<Record<string, OrderExample>> = {
  'with nothing used yet, one Recently used heading, then every card in Attention order without group headings': {
    steps: [{ at: 0, terminals: [
      t('w1', 'working'), t('i1', 'idle'), t('e1', 'flow-error'), t('h1', 'needs-human'), t('i2', 'unassigned'),
      t('w2', 'needs-human-working'), t('e2', 'disconnected'),
    ] }],
    list: [RECENTLY_USED_HEADING, d('e1'), d('e2'), d('h1'), d('i1'), d('i2'), d('w1'), d('w2')],
  },
  'with nothing used yet, the card longer in its group still comes first within the Attention order beneath the heading': {
    steps: [
      { at: 0, terminals: [t('a', 'idle'), t('b', 'flow-error'), t('c', 'working')] },
      { at: 5 * MINUTE, terminals: [t('a', 'flow-error'), t('b', 'flow-error'), t('c', 'working'), t('d', 'working')] },
    ],
    list: [RECENTLY_USED_HEADING, d('b'), d('a'), d('c'), d('d')],
  },
  'with no cards, no heading, as an empty status group shows none': {
    steps: [{ at: 0, terminals: [] }],
    list: [],
  },
};

/** Snapshots, as in `ORDER_EXAMPLES`; the directories (by `orderTerminal` name) that had a recency interaction, oldest
 *  first; and the list in `sortMode` after the last snapshot. */
export interface RecencyExample extends OrderExample { used: string[]; sortMode: SortMode }

export const RECENCY_EXAMPLES: Readonly<Record<string, RecencyExample>> = {
  'cards used in this run come first, most recent use first, then every other card in Attention order': {
    steps: [{ at: 0, terminals: [t('w1', 'working'), t('i1', 'idle'), t('e1', 'flow-error'), t('h1', 'needs-human'), t('i2', 'idle')] }],
    used: ['i2', 'w1'],
    sortMode: 'recently-used',
    list: [RECENTLY_USED_HEADING, d('w1'), d('i2'), d('e1'), d('h1'), d('i1')],
  },
  'a used card keeps its recency place though another card has been longer in its new group': {
    steps: [
      { at: 0, terminals: [t('a', 'idle'), t('b', 'idle'), t('c', 'flow-error')] },
      { at: 5 * MINUTE, terminals: [t('a', 'flow-error'), t('b', 'idle'), t('c', 'flow-error')] },
    ],
    used: ['a'],
    sortMode: 'recently-used',
    list: [RECENTLY_USED_HEADING, d('a'), d('c'), d('b')],
  },
  'Attention order ignores recency': {
    steps: [{ at: 0, terminals: [t('w1', 'working'), t('i1', 'idle'), t('e1', 'flow-error'), t('i2', 'idle')] }],
    used: ['i2', 'w1'],
    sortMode: 'attention',
    list: [heading('errors', 1), d('e1'), heading('idle', 2), d('i1'), d('i2'), heading('working', 1), d('w1')],
  },
};
