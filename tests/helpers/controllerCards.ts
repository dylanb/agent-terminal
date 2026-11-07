/// <reference lib="dom" />
import type { Locator, Page } from '@playwright/test';
import { STATUS_CLASSES, SUMMARY_LABELS } from './controllerStatusFixture';

export const CARD_SELECTOR = 'article';

export const CARD_ACCENT_TEST_ID = 'card-accent';
export const CARD_STATUS_TEST_ID = 'card-status';

export interface RoleScope<L> {
  getByRole(
    role: 'article' | 'button' | 'heading' | 'switch' | 'radio' | 'radiogroup' | 'region' | 'list' | 'listitem',
    options?: { name?: string | RegExp; exact?: boolean; expanded?: boolean; pressed?: boolean; checked?: boolean; level?: number },
  ): L;
  getByTestId(testId: string): L;
}
interface Alternatives<L> {
  or(other: L): L;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches `directory` as a whole path, so `/w/a` does not match a name holding `/w/ab` or `/w/a/b`. */
export function directoryPattern(directory: string): RegExp {
  return new RegExp(`(?<![\\w./-])${escapeRegExp(directory)}(?![\\w./-])`);
}

export const cardsLocator = <L>(scope: RoleScope<L>): L => scope.getByRole('article');
export const cardLocator = <L>(scope: RoleScope<L>, directory: string): L =>
  scope.getByRole('article', { name: directoryPattern(directory) });
/** The card for `directory` only while its accessible name also holds `text`. */
export const cardNamedLocator = <L>(scope: RoleScope<L>, directory: string, text: string): L =>
  scope.getByRole('article', { name: new RegExp(`^(?=[\\s\\S]*${directoryPattern(directory).source})(?=[\\s\\S]*${escapeRegExp(text)})`) });
const activationName = /^Bring\b[\s\S]*\bforward\b/;
export const bringForwardLocator = <L>(card: RoleScope<L>): L => card.getByRole('button', { name: activationName });
export const headerActivationLocator = <L extends RoleScope<L>>(card: { locator(selector: string): L }): L =>
  card.locator('header').getByRole('button', { name: activationName });
export const dismissLocator = <L>(card: RoleScope<L>): L => card.getByRole('button', { name: 'Dismiss disconnected terminal' });
const loopMessageDismissalName = /^Dismiss (?:loop error|notice) /;
export const dismissLoopMessageLocator = <L>(card: RoleScope<L>): L => card.getByRole('button', { name: loopMessageDismissalName });
export const showFullReasonLocator = <L>(card: RoleScope<L>): L => card.getByRole('button', { name: 'Show full reason' });
export const cardHeaderLocator = <L extends Alternatives<L>>(card: RoleScope<L>, directory: string): L =>
  card.getByRole('button', { name: directoryPattern(directory), expanded: true })
    .or(card.getByRole('button', { name: directoryPattern(directory), expanded: false }));
/** The theme control is named for the theme it switches to, so `on` (dark active) is the one named Light theme. */
export const themeControlLocator = <L>(scope: RoleScope<L>, state: { on?: boolean } = {}): L =>
  scope.getByRole('button', { name: state.on === undefined ? /^(Dark|Light) theme$/ : state.on ? 'Light theme' : 'Dark theme', exact: true });
export const alwaysOnTopLocator = <L>(scope: RoleScope<L>, state: { on?: boolean } = {}): L =>
  scope.getByRole('switch', { name: 'Always on top', exact: true, ...(state.on === undefined ? {} : { checked: state.on }) });
export const windowTitleLocator = <L>(scope: RoleScope<L>): L => scope.getByRole('heading', { name: 'Controller', exact: true });
export const windowHeaderLocator = <L>(scope: RoleScope<L> & { locator(selector: string, options?: { has?: L }): L }): L =>
  scope.locator('header', { has: windowTitleLocator(scope) });
export const accentLocator = <L>(card: RoleScope<L>): L => card.getByTestId(CARD_ACCENT_TEST_ID);
export const statusRowLocator = <L>(card: RoleScope<L>): L => card.getByTestId(CARD_STATUS_TEST_ID);

type DomRole = 'article' | 'button' | 'switch' | 'radio' | 'radiogroup' | 'heading' | 'region' | 'list' | 'listitem';
const implicitRoles: Record<string, DomRole> = {
  ARTICLE: 'article', BUTTON: 'button', H1: 'heading', H2: 'heading', H3: 'heading',
  H4: 'heading', H5: 'heading', H6: 'heading', OL: 'list', UL: 'list', LI: 'listitem',
};
const roleOf = (node: Element): string | undefined => node.getAttribute('role') ?? implicitRoles[node.tagName];
/** One entry of the card list in reading order: a list heading as its words and digits, punctuation dropped
 *  (`'Errors 2'`, `'Idle & unassigned 1'`, `'Recently used'`), or a card as the one directory its name holds. */
export type ListEntry = string;
interface ListProbe { card: string; directories: readonly string[]; patterns: readonly string[] }

// The helper's one name matcher. Playwright serialises it into the page for the list read, so it may reference
// nothing outside its own body. Without `list` it returns each node's accessible name; with it, the list entries.
function readNames(nodes: Element[], list?: ListProbe): string[] {
  const nameText = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return '';
    const text = [...node.childNodes].map(nameText).join('');
    return node instanceof HTMLElement && (node.style.display === 'block' || node.tagName === 'BDI') ? ` ${text} ` : text;
  };
  const nameOf = (control: Element): string => {
    const labels = control.getAttribute('aria-labelledby')?.split(/\s+/)
      .map(id => control.ownerDocument.getElementById(id)).filter((node): node is HTMLElement => !!node);
    if (labels?.length) return labels.map(nameText).join(' ');
    return control.getAttribute('aria-label') ?? nameText(control);
  };
  if (!list) return nodes.map(nameOf);
  const { card, directories, patterns } = list;
  const words = (text: string) => text.replace(/[^\p{L}\p{N}&\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
  return nodes.flatMap(node => {
    if (!node.matches(card)) return node.closest(card) ? [] : [words(nameOf(node))];
    const name = nameOf(node);
    const named = directories.filter((_, index) => new RegExp(patterns[index]).test(name));
    return [named.length === 1 ? named[0] : `a card naming ${named.length} of the directories: ${name}`];
  });
}
export const controlName = (control: Element | null | undefined): string => (control ? readNames([control])[0] : '');
const roleMatches = (scope: ParentNode, roles: DomRole[], name?: string | RegExp): HTMLElement[] =>
  [...scope.querySelectorAll<HTMLElement>('*')].filter(node =>
    roles.some(role => roleOf(node) === role)
    && (name === undefined || (typeof name === 'string' ? controlName(node).includes(name) : name.test(controlName(node)))));
const levelOf = (heading: Element): number => Number(heading.getAttribute('aria-level') ?? /^H([1-6])$/.exec(heading.tagName)?.[1]);
export const cardsIn = (root: ParentNode): HTMLElement[] => roleMatches(root, ['article']);
export function cardIn(root: ParentNode, directory: string): HTMLElement | undefined {
  const matches = roleMatches(root, ['article'], directoryPattern(directory));
  if (matches.length > 1) throw new Error(`${matches.length} cards hold ${directory}`);
  return matches[0];
}

/** Whether `card` shows `name` as a word of its own, apart from the copy of it inside `directory`. */
export function showsName(card: ParentNode | undefined, directory: string, name: string): boolean {
  if (!card) return false;
  const pattern = directoryPattern(name);
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (pattern.test((node.textContent ?? '').split(directory).join(' '))) return true;
  }
  return false;
}

export const windowHeaderIn = (root: ParentNode): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>('header')].find(header => !header.closest(CARD_SELECTOR));
const controlsIn = (scope: ParentNode, text: string | RegExp): HTMLElement[] => roleMatches(scope, ['button', 'switch'], text);
const controlIn = (scope: ParentNode, text: string | RegExp): HTMLElement | undefined => controlsIn(scope, text)[0];
export const bringForwardIn = (card: ParentNode) => controlIn(card, activationName);
export function headerActivationIn(card: ParentNode): HTMLElement | undefined {
  const header = card.querySelector('header');
  return header ? roleMatches(header, ['button'], activationName).find(button => !button.hasAttribute('aria-expanded')) : undefined;
}
export const bodyActivationIn = (card: ParentNode): HTMLElement | undefined =>
  roleMatches(card, ['button'], activationName).find(button => !button.closest('header'));
export const bodyControlIn = (card: ParentNode): HTMLElement | undefined =>
  roleMatches(card, ['button', 'switch']).find(control => !control.closest('header'));
export function bodyDirectoryIn(card: ParentNode, directory: string): HTMLElement | undefined {
  const pattern = directoryPattern(directory);
  return [...card.querySelectorAll<HTMLElement>('*')].find(element =>
    !element.closest('header') && !element.closest('[hidden]')
    && [...element.childNodes].some(node => node.nodeType === 3 && pattern.test(node.textContent ?? '')));
}
export const dismissIn = (card: ParentNode) => controlIn(card, 'Dismiss');
export const dismissLoopMessageIn = (card: ParentNode) => controlIn(card, loopMessageDismissalName);
export const showFullReasonIn = (card: ParentNode) => controlIn(card, 'Show full reason');
export const showFullReasonsIn = (card: ParentNode): HTMLElement[] => controlsIn(card, 'Show full reason');
export const windowTitleIn = (root: ParentNode): HTMLElement | undefined =>
  roleMatches(root, ['heading'], /^Controller$/).find(heading => !heading.closest(CARD_SELECTOR));
export const themeControlIn = (root: ParentNode) => controlIn(root, 'Dark theme') ?? controlIn(root, 'Light theme');
export const alwaysOnTopIn = (root: ParentNode): HTMLElement | undefined =>
  roleMatches(root, ['switch'], /^\s*Always on top\s*$/).find(control => !control.closest(CARD_SELECTOR));
export function alwaysOnTopOn(root: ParentNode): boolean {
  const control = alwaysOnTopIn(root);
  if (!control) throw new Error('No Always on top switch');
  const checked = control.getAttribute('aria-checked');
  if (checked !== 'true' && checked !== 'false') throw new Error('Always on top exposes no aria-checked state');
  return checked === 'true';
}
export function darkThemeOn(root: ParentNode): boolean {
  const control = themeControlIn(root);
  if (!control) throw new Error('No Dark theme or Light theme control');
  return controlName(control).trim() === 'Light theme';
}
export const cardHeaderIn = (card: ParentNode, directory: string): HTMLElement | undefined =>
  roleMatches(card, ['button'], directoryPattern(directory)).find(button => button.hasAttribute('aria-expanded'));
export function isExpanded(card: ParentNode, directory: string): boolean {
  const header = cardHeaderIn(card, directory);
  if (!header) throw new Error(`No disclosure header for ${directory}`);
  return header.getAttribute('aria-expanded') === 'true';
}
export const cardHeaderTextIn = (card: ParentNode): string => card.querySelector('header')?.textContent ?? '';
export const cardHeaderElementLocator = <L>(card: { locator(selector: string): L }): L => card.locator('header');

export function headerRemainder(headerText: string, named: readonly string[]): string {
  return named.reduce((text, part) => (part ? text.split(part).join(' ') : text), headerText).replace(/[\s·]+/g, ' ').trim();
}

export const accentIn = (card: ParentNode): HTMLElement | null => card.querySelector(`[data-testid="${CARD_ACCENT_TEST_ID}"]`);
export const statusRowIn = (card: ParentNode): HTMLElement | null => card.querySelector(`[data-testid="${CARD_STATUS_TEST_ID}"]`);

/** Labels whose counts the header shows, in one orientation for all of them ("<n> <label>" or "<label> <n>"), so
 *  a label without a number cannot borrow its neighbour's. */
export function unshownCounts(text: string, counts: ReadonlyArray<readonly [string, number]>): string[] {
  const orientations = [
    (label: string, count: number) => new RegExp(`(?<![\\w-])${count}\\s*(?:${label})\\b`, 'i'),
    (label: string, count: number) => new RegExp(`(?<![\\w-])(?:${label})\\W*${count}(?!\\d)`, 'i'),
  ];
  const misses = orientations.map(shown => counts.filter(([label, count]) => !shown(label, count).test(text)));
  const best = misses.reduce((a, b) => (b.length < a.length ? b : a));
  return best.map(([label, count]) => `${label} does not show ${count}`);
}
export const headerLabels = (summary: (label: string) => number, total: number, connected: number): Array<[string, number]> => [
  ['total|cards?|terminals?', total], ['connected', connected], ['disconnected', total - connected],
  ...SUMMARY_LABELS.map(label => [label, summary(label)] as [string, number]),
];
/** Whether a Show full reason control reports its reason as shown in full, through whichever of expanded, pressed or
 *  checked it exposes; a throw when it exposes none. */
export function showsFullReason(control: Element | undefined): boolean {
  const state = ['aria-expanded', 'aria-pressed', 'aria-checked'].map(name => control?.getAttribute(name)).find(value => value === 'true' || value === 'false');
  if (state === undefined) throw new Error('Show full reason exposes no state');
  return state === 'true';
}

export const historyLocator = <L>(card: RoleScope<L>): L => card.getByRole('button', { name: /History\s+\d\s*\/\s*3/i });
export const historyIn = (card: ParentNode): HTMLElement | undefined => controlIn(card, /History\s+\d\s*\/\s*3/i);

export const timelineLocator = <L extends RoleScope<L>>(card: RoleScope<L>): L => card.getByRole('list');
export const timelineEntriesLocator = <L extends RoleScope<L>>(card: RoleScope<L>): L => timelineLocator(card).getByRole('listitem');
export const timelineIn = (card: ParentNode): HTMLElement | undefined => roleMatches(card, ['list'])[0];
export const timelineEntriesIn = (card: ParentNode): HTMLElement[] => {
  const list = timelineIn(card);
  return list ? roleMatches(list, ['listitem']) : [];
};
export const entryAccessibleText = (entry: Element): string => controlName(entry);
export const entryTimesIn = (entry: ParentNode): HTMLTimeElement[] => [...entry.querySelectorAll('time')];
export const entryIsNotification = (entry: Element): boolean => /notification/i.test(entryAccessibleText(entry));

export const clearHistoryLocator = <L>(card: RoleScope<L>): L => card.getByRole('button', { name: /Clear history/i });
export const clearHistoryIn = (card: ParentNode): HTMLElement | undefined => controlIn(card, /Clear history/i);
/** Each field names the status class painting that part, or says why no single class does. */
export interface PaintedStatus { accent: string; text: string }
interface PaintProbe { classes: readonly string[]; accentTestId: string; statusTestId: string }
const PAINT_PROBE: PaintProbe = { classes: STATUS_CLASSES, accentTestId: CARD_ACCENT_TEST_ID, statusTestId: CARD_STATUS_TEST_ID };

// Playwright serialises this into the page, so it may reference nothing outside its own body.
function paintedStatus(card: Element, { classes, accentTestId, statusTestId }: PaintProbe): PaintedStatus {
  const probe = card.ownerDocument.createElement('span');
  card.append(probe);
  try {
    const tokenColour = (token: string): string => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    const classOf = (element: Element | null | undefined, property: 'backgroundColor' | 'color', suffix: string): string => {
      if (!element) return 'not shown';
      const painted = getComputedStyle(element)[property];
      const matches = classes.filter(statusClass => tokenColour(`--status-${statusClass}${suffix}`) === painted);
      return matches.length === 1 ? matches[0] : `${matches.join(' or ') || 'no status class'} painted ${painted}`;
    };
    const row = card.querySelector(`[data-testid="${statusTestId}"]`);
    const label = row?.checkVisibility()
      ? row
      : [...card.querySelectorAll('header *')].filter(element => element.textContent === row?.textContent).at(-1);
    return { accent: classOf(card.querySelector(`[data-testid="${accentTestId}"]`), 'backgroundColor', ''), text: classOf(label, 'color', '-text') };
  } finally {
    probe.remove();
  }
}

export const paintedStatusIn = (card: Element): PaintedStatus => paintedStatus(card, PAINT_PROBE);
export const paintedStatusOf = (card: { evaluate(fn: typeof paintedStatus, probe: PaintProbe): Promise<PaintedStatus> }): Promise<PaintedStatus> =>
  card.evaluate(paintedStatus, PAINT_PROBE);

const LIST_HEADING_LEVEL = 2;
const listProbe = (directories: readonly string[]): ListProbe =>
  ({ card: CARD_SELECTOR, directories, patterns: directories.map(directory => directoryPattern(directory).source) });

/** The card list in reading order — its level-2 headings outside any card, and each card as its directory — so
 *  one comparison catches a missing or extra heading, a wrong count, or a card out of place. */
export function listSequenceIn(root: ParentNode, directories: readonly string[]): ListEntry[] {
  const shown = roleMatches(root, ['article', 'heading'])
    .filter(node => !node.closest('[hidden], [aria-hidden="true"]') && (roleOf(node) === 'article' || levelOf(node) === LIST_HEADING_LEVEL));
  return readNames(shown, listProbe(directories));
}
/** `listSequenceIn` for Playwright, read in one pass so a re-render cannot interleave with it. */
export const listSequenceOf = (scope: Page | Locator, directories: readonly string[]): Promise<ListEntry[]> =>
  scope.getByRole('heading', { level: LIST_HEADING_LEVEL }).or(scope.getByRole('article')).evaluateAll(readNames, listProbe(directories));
/** The level of each heading inside `card`, in reading order. */
export const cardHeadingLevelsIn = (card: ParentNode): number[] => roleMatches(card, ['heading']).map(levelOf);

/** The status text a card header shows, with its time in state: `· <verb> <duration>`, then ` · position held`
 *  while the card is held. Matched against the end of the header toggle's text. */
export const TIME_LABEL_FORMAT = / · (?:waiting|running|for) (?:under 1m|\d+m|\d+h \d+m|\d+d \d+h)(?: · position held)?$/;
/** The visible text of the card's header toggle — name, identity and status label — whitespace collapsed. */
export function headerStatusIn(card: ParentNode, directory: string): string {
  const header = cardHeaderIn(card, directory);
  if (!header) throw new Error(`No disclosure header for ${directory}`);
  return (header.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export const SORT_OPTIONS = ['Attention', 'Recently used'] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];
const SORT_CONTROL_NAME = 'Sort cards';
export const sortControlLocator = <L>(scope: RoleScope<L>): L => scope.getByRole('radiogroup', { name: SORT_CONTROL_NAME, exact: true });
export const sortOptionLocator = <L>(scope: RoleScope<L>, option: SortOption, state: { selected?: boolean } = {}): L =>
  scope.getByRole('radio', { name: option, exact: true, ...(state.selected === undefined ? {} : { checked: state.selected }) });
export const sortControlIn = (root: ParentNode): HTMLElement | undefined => roleMatches(root, ['radiogroup'], /^\s*Sort cards\s*$/)[0];
export const sortOptionIn = (root: ParentNode, option: SortOption): HTMLElement | undefined =>
  roleMatches(root, ['radio'], new RegExp(`^\\s*${escapeRegExp(option)}\\s*$`))[0];
/** The names of the selected sort options; a throw when no option is shown, or one exposes no `aria-checked`. */
export function selectedSortOptionsIn(root: ParentNode): string[] {
  const options = roleMatches(root, ['radio']);
  if (!options.length) throw new Error('No sort option');
  return options.filter(option => {
    const checked = option.getAttribute('aria-checked');
    if (checked !== 'true' && checked !== 'false') throw new Error(`Sort option ${controlName(option).trim()} exposes no aria-checked state`);
    return checked === 'true';
  }).map(option => controlName(option).trim());
}
