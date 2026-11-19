/// <reference lib="dom" />
// How every token-count test reads the screen (UI-STANDARDS §3.4): the Settings switch that shows the counts, the
// rail's per-step totals and run total, and the docked panel's "Tokens by step" table. The switch, step list, table
// and the table's scroll region are found by role and accessible name, each station by its step's visible text in
// the step list, and the count parts by their test ids. The DOM functions serve the jsdom and `browser` tests and the
// Locator functions the e2e; both read the same names below.

import type { Locator } from '@playwright/test';
import type { FlowTokensView } from '../../src/shared/ipc';

type TokenKind = keyof Extract<NonNullable<FlowTokensView['run']>, { state: 'counted' }>['kinds'];

export const RAIL_STEP_LIST_NAME = 'Flow steps';
export const TOKEN_TABLE_NAME = 'Tokens by step';
export const RUN_TOTAL_ROW = 'Run total';
export const SHOW_TOKEN_COUNTS_NAME = 'Show token counts';
/** The docked loop panel's own control, there whenever the panel has rendered. */
const PANEL_CLOSE_NAME = 'Close loop panel';
const SHELL_PANEL_NAME = 'Loop and gate';
export const KIND_HEADERS: Record<TokenKind, string> = {
  cacheRead: 'Cache read',
  cacheWrite: 'Cache write',
  input: 'Uncached input',
  output: 'Output',
};
/** The part of a rail station, or of the rail's run total, that shows its count and markers. */
export const TOKEN_COUNT_TEST_ID = 'token-count';
export const RAIL_RUN_TOTAL_TEST_ID = 'token-run-total';

// ---- Playwright (e2e) ----

/** The Settings switch that turns the counts on and off; with `on`, only while it reads that state. */
export const showTokenCountsLocator = (scope: Pick<Locator, 'getByRole'>, state: { on?: boolean } = {}): Locator =>
  scope.getByRole('switch', { name: SHOW_TOKEN_COUNTS_NAME, exact: true, ...(state.on === undefined ? {} : { checked: state.on }) });
export const railStepListLocator = (scope: Pick<Locator, 'getByRole'>): Locator =>
  scope.getByRole('list', { name: RAIL_STEP_LIST_NAME, exact: true });
/** The station whose name, an element of its own, reads exactly `step`, so `plan` never finds `plan-approve`. */
export const railStationLocator = (scope: Pick<Locator, 'getByRole'>, step: string): Locator => {
  const list = railStepListLocator(scope);
  return list.getByRole('listitem').filter({ has: list.page().getByText(step, { exact: true }) });
};
export const railTotalLocator = (scope: Pick<Locator, 'getByRole'>, step: string): Locator =>
  railStationLocator(scope, step).getByTestId(TOKEN_COUNT_TEST_ID);
export const railRunTotalLocator = (scope: Pick<Locator, 'getByTestId'>): Locator =>
  scope.getByTestId(RAIL_RUN_TOTAL_TEST_ID).getByTestId(TOKEN_COUNT_TEST_ID);
/** The counts in the stations of `steps` and in the rail run total, for checking that none shows: it first waits
 *  for each station, so a rail that never rendered fails rather than showing no count. */
export async function railCountsLocator(scope: Pick<Locator, 'getByRole' | 'getByTestId'>, steps: [string, ...string[]]): Promise<Locator> {
  let counts = scope.getByTestId(RAIL_RUN_TOTAL_TEST_ID);
  for (const step of steps) {
    const station = railStationLocator(scope, step);
    await station.waitFor();
    counts = counts.or(station.getByTestId(TOKEN_COUNT_TEST_ID));
  }
  return counts;
}
export const tokenTableLocator = (scope: Pick<Locator, 'getByRole'>): Locator =>
  scope.getByRole('table', { name: TOKEN_TABLE_NAME, exact: true });
/** The "Tokens by step" table inside the app's docked loop panel, for checking that none shows: it first waits for
 *  the open panel, so a panel that never rendered fails rather than showing no table. */
export async function panelTokenTableLocator(scope: Pick<Locator, 'getByRole'>): Promise<Locator> {
  const panel = scope.getByRole('complementary', { name: SHELL_PANEL_NAME, exact: true });
  await panel.getByRole('button', { name: PANEL_CLOSE_NAME, exact: true }).waitFor();
  return tokenTableLocator(panel);
}

/** The cell of `kind` in the row headed `row` (a step's name, or RUN_TOTAL_ROW), placed through the column header's
 *  own index, so a table whose columns are reordered still finds the right cell. */
export async function tokenCellLocator(table: Locator, row: string, kind: TokenKind): Promise<Locator> {
  const column = await table
    .getByRole('columnheader', { name: KIND_HEADERS[kind], exact: true })
    .evaluate((header) => (header as HTMLTableCellElement).cellIndex);
  return table
    .getByRole('row')
    .filter({ has: table.page().getByRole('rowheader', { name: row, exact: true }) })
    .locator(`xpath=./*[${column + 1}]`);
}

// ---- DOM (jsdom and browser tests) ----

type DomRole = 'list' | 'listitem' | 'table' | 'row' | 'rowheader' | 'columnheader' | 'cell' | 'button' | 'switch' | 'region';

function implicitRole(el: Element): string | undefined {
  switch (el.tagName) {
    case 'UL':
    case 'OL':
      return 'list';
    case 'LI':
      return 'listitem';
    case 'TABLE':
      return 'table';
    case 'TR':
      return 'row';
    case 'TD':
      return 'cell';
    case 'BUTTON':
      return 'button';
    case 'TH':
      return el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader';
    default:
      return undefined;
  }
}
const roleOf = (el: Element): string | undefined => el.getAttribute('role') ?? implicitRole(el);

const visibleText = (node: Node): string => {
  if (node.nodeType === node.TEXT_NODE) return node.textContent ?? '';
  if (node instanceof Element && node.getAttribute('aria-hidden') === 'true') return '';
  return [...node.childNodes].map(visibleText).join('');
};
const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

function accessibleName(el: Element): string {
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) return squash(labelledBy.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '').join(' '));
  const label = el.getAttribute('aria-label');
  if (label !== null) return squash(label);
  if (el instanceof HTMLTableElement) return squash(el.caption?.textContent ?? '');
  return squash(visibleText(el));
}

/** What assistive technology reads for a count: its label when it has one, otherwise its text minus hidden parts. */
export const accessibleTextOf = (el: Element): string => {
  const label = el.getAttribute('aria-label');
  return label !== null ? squash(label) : squash(visibleText(el));
};

/** Every element under `scope` with `role` whose accessible name is `name` (any name when absent): the one matcher
 *  every DOM query here goes through. */
function allByRole(scope: ParentNode, role: DomRole, name?: string): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>('*')].filter((el) => roleOf(el) === role && (name === undefined || accessibleName(el) === name));
}

function only<T>(found: T[], what: string): T {
  if (found.length !== 1) throw new Error(`expected exactly one ${what}, found ${found.length}`);
  return found[0];
}

const testIdIn = (scope: ParentNode, id: string): HTMLElement[] => [...scope.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

export const showTokenCountsIn = (root: ParentNode): HTMLElement =>
  only(allByRole(root, 'switch', SHOW_TOKEN_COUNTS_NAME), `"${SHOW_TOKEN_COUNTS_NAME}" switch`);
/** Whether the "Show token counts" switch reads on; a switch that states neither on nor off throws. */
export function showTokenCountsOn(root: ParentNode): boolean {
  const checked = showTokenCountsIn(root).getAttribute('aria-checked');
  if (checked !== 'true' && checked !== 'false') throw new Error(`"${SHOW_TOKEN_COUNTS_NAME}" exposes no aria-checked state`);
  return checked === 'true';
}

export function railStationIn(root: ParentNode, step: string): HTMLElement {
  const list = only(allByRole(root, 'list', RAIL_STEP_LIST_NAME), `"${RAIL_STEP_LIST_NAME}" list`);
  const named = (item: Element): boolean => [...item.querySelectorAll('*')].some((el) => squash(visibleText(el)) === step);
  return only(allByRole(list, 'listitem').filter(named), `station for ${step}`);
}
export const railTotalIn = (root: ParentNode, step: string): HTMLElement =>
  only(testIdIn(railStationIn(root, step), TOKEN_COUNT_TEST_ID), `count in the station for ${step}`);
export const railRunTotalIn = (root: ParentNode): HTMLElement =>
  only(testIdIn(only(testIdIn(root, RAIL_RUN_TOTAL_TEST_ID), 'rail run total'), TOKEN_COUNT_TEST_ID), 'count in the rail run total');
/** The counts in the stations of `steps` and in the rail run total, for checking that none shows: a missing
 *  station throws, so a rail that never rendered fails rather than showing no count. */
export const railCountsIn = (root: ParentNode, steps: [string, ...string[]]): HTMLElement[] => [
  ...steps.flatMap((step) => testIdIn(railStationIn(root, step), TOKEN_COUNT_TEST_ID)),
  ...testIdIn(root, RAIL_RUN_TOTAL_TEST_ID),
];
export const tokenTableIn = (root: ParentNode): HTMLTableElement =>
  only(allByRole(root, 'table', TOKEN_TABLE_NAME), `"${TOKEN_TABLE_NAME}" table`) as HTMLTableElement;

/** The "Tokens by step" tables in the rendered docked loop panel `panel`, for checking that none shows: a panel
 *  that has not rendered throws, so it fails rather than showing no table. */
export function panelTokenTablesIn(panel: ParentNode): HTMLElement[] {
  only(allByRole(panel, 'button', PANEL_CLOSE_NAME), `"${PANEL_CLOSE_NAME}" button of a rendered loop panel`);
  return allByRole(panel, 'table', TOKEN_TABLE_NAME);
}

/** The scroll region holding the panel's table, named as the table is. */
export const panelTokenRegionIn = (panel: ParentNode): HTMLElement =>
  only(allByRole(panel, 'region', TOKEN_TABLE_NAME), `"${TOKEN_TABLE_NAME}" region`);

/** The cell of `kind` in the row headed `row`, associated through the native header cells. */
export function tokenCellIn(root: ParentNode, row: string, kind: TokenKind): HTMLTableCellElement {
  const table = tokenTableIn(root);
  const header = only(allByRole(table, 'columnheader', KIND_HEADERS[kind]), `"${KIND_HEADERS[kind]}" column header`) as HTMLTableCellElement;
  const rowHeader = only(allByRole(table, 'rowheader', row), `"${row}" row header`);
  const tr = rowHeader.closest('tr');
  const cell = tr?.cells[header.cellIndex];
  if (cell === undefined) throw new Error(`row "${row}" has no cell under "${KIND_HEADERS[kind]}"`);
  return cell;
}
