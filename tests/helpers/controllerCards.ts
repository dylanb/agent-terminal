/// <reference lib="dom" />
import { SUMMARY_LABELS } from './controllerStatusFixture';

// The § Card DOM contract, spelt once. Playwright pages and locators and vitest-browser `page` and locators all
// satisfy `RoleScope`, so the browser tests and the e2e locate cards with the same role-and-name queries; the
// `…In` functions are the jsdom counterparts, which match the `aria-label` or else the text, because jsdom here
// has no accessible-name engine.

export const CARD_ACCENT_TEST_ID = 'card-accent';
export const CARD_STATUS_TEST_ID = 'card-status';

export interface RoleScope<L> {
  getByRole(
    role: 'article' | 'button' | 'heading' | 'switch',
    options?: { name?: string | RegExp; exact?: boolean; expanded?: boolean; pressed?: boolean; checked?: boolean },
  ): L;
  getByTestId(testId: string): L;
}
interface Alternatives<L> {
  or(other: L): L;
}

/** Matches `directory` as a whole path, so `/w/a` does not match a name holding `/w/ab` or `/w/a/b`. */
export function directoryPattern(directory: string): RegExp {
  const escaped = directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w./-])${escaped}(?![\\w./-])`);
}

export const cardsLocator = <L>(scope: RoleScope<L>): L => scope.getByRole('article');
export const cardLocator = <L>(scope: RoleScope<L>, directory: string): L =>
  scope.getByRole('article', { name: directoryPattern(directory) });
export const bringForwardLocator = <L>(card: RoleScope<L>): L => card.getByRole('button', { name: 'Bring forward' });
export const dismissLocator = <L>(card: RoleScope<L>): L => card.getByRole('button', { name: 'Dismiss disconnected terminal' });
export const showFullReasonLocator = <L>(card: RoleScope<L>): L => card.getByRole('button', { name: 'Show full reason' });
export const cardHeaderLocator = <L extends Alternatives<L>>(card: RoleScope<L>, directory: string): L =>
  card.getByRole('button', { name: directoryPattern(directory), expanded: true })
    .or(card.getByRole('button', { name: directoryPattern(directory), expanded: false }));
export const darkThemeLocator = <L extends Alternatives<L>>(scope: RoleScope<L>, state: { on?: boolean } = {}): L =>
  scope.getByRole('button', { name: 'Dark theme', exact: true, ...(state.on === undefined ? {} : { pressed: state.on }) })
    .or(scope.getByRole('switch', { name: 'Dark theme', exact: true, ...(state.on === undefined ? {} : { checked: state.on }) }));
export const windowTitleLocator = <L>(scope: RoleScope<L>): L => scope.getByRole('heading', { name: 'Controller', exact: true });
export const windowHeaderLocator = <L>(scope: RoleScope<L> & { locator(selector: string, options?: { has?: L }): L }): L =>
  scope.locator('header', { has: windowTitleLocator(scope) });
export const accentLocator = <L>(card: RoleScope<L>): L => card.getByTestId(CARD_ACCENT_TEST_ID);
export const statusRowLocator = <L>(card: RoleScope<L>): L => card.getByTestId(CARD_STATUS_TEST_ID);

export const cardsIn = (root: ParentNode): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('article')];

// Any node in the subtree, not only the root: `textContent` joins sibling elements with no separator, so a name
// beside the directory reads as one word and fails the whole-path match, while a directory split across spans
// is whole only in an ancestor's text.
const holdsDirectory = (node: Node, pattern: RegExp): boolean =>
  pattern.test(node.textContent ?? '') || [...node.childNodes].some(child => holdsDirectory(child, pattern));

/** The card whose text holds `directory`; `undefined` when none does, and a throw when several do. */
export function cardIn(root: ParentNode, directory: string): HTMLElement | undefined {
  const pattern = directoryPattern(directory);
  const matches = cardsIn(root).filter(card => holdsDirectory(card, pattern));
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
  [...root.querySelectorAll<HTMLElement>('header')].find(header => !header.closest('article'));
export const controlName = (control: Element | null | undefined): string => control?.getAttribute('aria-label') ?? control?.textContent ?? '';
const controlsIn = (scope: ParentNode, text: string): HTMLElement[] =>
  [...scope.querySelectorAll<HTMLElement>('button, [role="button"], [role="switch"]')].filter(control => controlName(control).includes(text));
const controlIn = (scope: ParentNode, text: string): HTMLElement | undefined => controlsIn(scope, text)[0];
export const bringForwardIn = (card: ParentNode) => controlIn(card, 'Bring forward');
export const dismissIn = (card: ParentNode) => controlIn(card, 'Dismiss');
export const showFullReasonIn = (card: ParentNode) => controlIn(card, 'Show full reason');
export const showFullReasonsIn = (card: ParentNode): HTMLElement[] => controlsIn(card, 'Show full reason');
export const windowTitleIn = (root: ParentNode): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, [role="heading"]')]
    .find(heading => !heading.closest('article') && heading.textContent?.trim() === 'Controller');
export const darkThemeIn = (root: ParentNode) => controlIn(root, 'Dark theme');
export function darkThemeOn(root: ParentNode): boolean {
  const control = darkThemeIn(root);
  if (!control) throw new Error('No Dark theme control');
  return control.getAttribute('aria-pressed') === 'true' || control.getAttribute('aria-checked') === 'true';
}
export const cardHeaderIn = (card: ParentNode, directory: string): HTMLElement | undefined =>
  [...card.querySelectorAll<HTMLElement>('button[aria-expanded]')].find(button => holdsDirectory(button, directoryPattern(directory)));
export function isExpanded(card: ParentNode, directory: string): boolean {
  const header = cardHeaderIn(card, directory);
  if (!header) throw new Error(`No disclosure header for ${directory}`);
  return header.getAttribute('aria-expanded') === 'true';
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
  ['total|terminals?', total], ['connected', connected], ['disconnected', total - connected],
  ...SUMMARY_LABELS.map(label => [label, summary(label)] as [string, number]),
];
/** Whether a Show full reason control reports its reason as shown in full, through whichever of expanded, pressed or
 *  checked it exposes; a throw when it exposes none. */
export function showsFullReason(control: Element | undefined): boolean {
  const state = ['aria-expanded', 'aria-pressed', 'aria-checked'].map(name => control?.getAttribute(name)).find(value => value === 'true' || value === 'false');
  if (state === undefined) throw new Error('Show full reason exposes no state');
  return state === 'true';
}
