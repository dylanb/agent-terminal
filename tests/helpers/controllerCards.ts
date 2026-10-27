/// <reference lib="dom" />
import { SUMMARY_LABELS } from './controllerStatusFixture';

export const CARD_SELECTOR = 'article';

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
const activationName = /Bring (?:both |[0-9]+ terminals )?forward/;
export const bringForwardLocator = <L>(card: RoleScope<L>): L => card.getByRole('button', { name: activationName });
export const dismissLocator = <L>(card: RoleScope<L>): L => card.getByRole('button', { name: 'Dismiss disconnected terminal' });
export const showFullReasonLocator = <L>(card: RoleScope<L>): L => card.getByRole('button', { name: 'Show full reason' });
export const cardHeaderLocator = <L extends Alternatives<L>>(card: RoleScope<L>, directory: string): L =>
  card.getByRole('button', { name: directoryPattern(directory), expanded: true })
    .or(card.getByRole('button', { name: directoryPattern(directory), expanded: false }));
/** The theme control is named for the theme it switches to, so `on` (dark active) is the one named Light theme. */
export const themeControlLocator = <L>(scope: RoleScope<L>, state: { on?: boolean } = {}): L =>
  scope.getByRole('button', { name: state.on === undefined ? /^(Dark|Light) theme$/ : state.on ? 'Light theme' : 'Dark theme', exact: true });
export const windowTitleLocator = <L>(scope: RoleScope<L>): L => scope.getByRole('heading', { name: 'Controller', exact: true });
export const windowHeaderLocator = <L>(scope: RoleScope<L> & { locator(selector: string, options?: { has?: L }): L }): L =>
  scope.locator('header', { has: windowTitleLocator(scope) });
export const accentLocator = <L>(card: RoleScope<L>): L => card.getByTestId(CARD_ACCENT_TEST_ID);
export const statusRowLocator = <L>(card: RoleScope<L>): L => card.getByTestId(CARD_STATUS_TEST_ID);

type DomRole = 'article' | 'button' | 'switch' | 'heading';
const implicitRoles: Record<string, DomRole> = {
  ARTICLE: 'article', BUTTON: 'button', H1: 'heading', H2: 'heading', H3: 'heading',
  H4: 'heading', H5: 'heading', H6: 'heading',
};
const roleOf = (node: Element): string | undefined => node.getAttribute('role') ?? implicitRoles[node.tagName];
const nameText = (node: Node): string => {
  if (node.nodeType === 3) return node.textContent ?? '';
  if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return '';
  const text = [...node.childNodes].map(nameText).join('');
  return node instanceof HTMLElement && (node.style.display === 'block' || node.tagName === 'BDI') ? ` ${text} ` : text;
};
export const controlName = (control: Element | null | undefined): string => {
  if (!control) return '';
  const labels = control.getAttribute('aria-labelledby')?.split(/\s+/)
    .map(id => control.ownerDocument.getElementById(id)).filter((node): node is HTMLElement => !!node);
  if (labels?.length) return labels.map(nameText).join(' ');
  return control.getAttribute('aria-label') ?? nameText(control);
};
const roleMatches = (scope: ParentNode, roles: DomRole[], name?: string | RegExp): HTMLElement[] =>
  [...scope.querySelectorAll<HTMLElement>('*')].filter(node =>
    roles.some(role => roleOf(node) === role)
    && (name === undefined || (typeof name === 'string' ? controlName(node).includes(name) : name.test(controlName(node)))));
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
export const dismissIn = (card: ParentNode) => controlIn(card, 'Dismiss');
export const showFullReasonIn = (card: ParentNode) => controlIn(card, 'Show full reason');
export const showFullReasonsIn = (card: ParentNode): HTMLElement[] => controlsIn(card, 'Show full reason');
export const windowTitleIn = (root: ParentNode): HTMLElement | undefined =>
  roleMatches(root, ['heading'], /^Controller$/).find(heading => !heading.closest(CARD_SELECTOR));
export const themeControlIn = (root: ParentNode) => controlIn(root, 'Dark theme') ?? controlIn(root, 'Light theme');
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
