/// <reference lib="dom" />

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

export const windowHeaderIn = (root: ParentNode): HTMLElement | undefined =>
  [...root.querySelectorAll<HTMLElement>('header')].find(header => !header.closest('article'));
const controlIn = (scope: ParentNode, text: string): HTMLElement | undefined =>
  [...scope.querySelectorAll<HTMLElement>('button, [role="switch"]')]
    .find(control => (control.getAttribute('aria-label') ?? control.textContent ?? '').includes(text));
export const bringForwardIn = (card: ParentNode) => controlIn(card, 'Bring forward');
export const dismissIn = (card: ParentNode) => controlIn(card, 'Dismiss');
export const showFullReasonIn = (card: ParentNode) => controlIn(card, 'Show full reason');
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
