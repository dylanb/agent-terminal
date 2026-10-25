import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';
import { accentIn, cardIn, statusRowIn, windowHeaderIn, windowTitleLocator } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { STATUS_CASES, statusTerminal, type StatusCaseKey } from '../helpers/controllerStatusFixture';
import type { StatusToken } from '../helpers/designTokens';
import { readColors, sameColor } from '../helpers/tokenProbe';
import { parseColor } from '../helpers/wcag';

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
});

const CLASS_CASES: StatusCaseKey[] = ['disconnected', 'flow-error', 'needs-human', 'working', 'completed', 'idle'];
const SUMMARY_CLASS = { errors: 'error', 'need a human': 'needs-human', idle: 'idle', working: 'working' } as const;
const noTicket = { ...statusTerminal({ ticket: { availability: 'none' } }), id: 'no-ticket', launchDirectory: '/muted/no-ticket' };
const titleLoading = { ...statusTerminal({ ticket: { availability: 'known', number: 219, title: { availability: 'loading' } } }), id: 'title-loading', launchDirectory: '/muted/title-loading' };

/** The elements holding `text` none of whose children also hold it: where that text is painted. */
const holders = (root: ParentNode | undefined, text: string): HTMLElement[] => root
  ? [...root.querySelectorAll<HTMLElement>('*')].filter(element => element.textContent?.includes(text)
    && ![...element.children].some(child => child.textContent?.includes(text)))
  : [];

/** The nearest element from `element` up to `card` that paints a background of its own. */
function tintedAncestor(element: HTMLElement | undefined, card: HTMLElement): HTMLElement | undefined {
  for (let node: HTMLElement | null = element ?? null; node && card.contains(node) && node !== card; node = node.parentElement) {
    if (parseColor(getComputedStyle(node).backgroundColor)[3] > 0) return node;
  }
  return undefined;
}

const stack = (family: string): string[] => family.split(',').map(name => name.trim().replace(/^["']|["']$/g, ''));

function mount(theme: string) {
  document.documentElement.dataset.theme = theme;
  const terminals = [...CLASS_CASES.map(key => STATUS_CASES[key].terminal), STATUS_CASES.unassigned.terminal, noTicket, titleLoading];
  return mountControllerPanes({ terminals });
}

function paints(painted: string | undefined, token: StatusToken | '--dim', what: string): string[] {
  const expected = readColors([token])[token];
  if (!expected) return [`${token} is undefined`];
  return painted && sameColor(parseColor(painted), expected) ? [] : [`${what} painted ${painted}, expected ${token}`];
}

describe.each(['light', 'dark'])('controller card colours in %s', theme => {
  it('paints each class accent in --status-<class> and its status row in --status-<class>-text', () => {
    const { host, dispose } = mount(theme);
    try {
      expect(CLASS_CASES.flatMap(key => {
        const { terminal, statusClass } = STATUS_CASES[key];
        const card = cardIn(host, terminal.launchDirectory);
        const accent = card ? accentIn(card) : null;
        const status = card ? statusRowIn(card) : null;
        return [
          ...paints(accent ? getComputedStyle(accent).backgroundColor : undefined, `--status-${statusClass}`, `${key} accent`),
          ...paints(status ? getComputedStyle(status).color : undefined, `--status-${statusClass}-text`, `${key} status row`),
        ];
      })).toEqual([]);
    } finally { dispose(); }
  });

  it('paints each summary label in its class status-text colour', () => {
    const { host, dispose } = mount(theme);
    try {
      const header = windowHeaderIn(host);
      expect(Object.entries(SUMMARY_CLASS).flatMap(([label, statusClass]) => {
        const element = holders(header, label)[0];
        return paints(element ? getComputedStyle(element).color : undefined, `--status-${statusClass}-text`, `"${label}" label`);
      })).toEqual([]);
    } finally { dispose(); }
  });

  it('tints the human-needed and error condition boxes with their class tint', () => {
    const { host, dispose } = mount(theme);
    try {
      expect(([['needs-human', 'Human needed: needs a human', '--status-needs-human-tint'], ['flow-error', 'Step exited 1', '--status-error-tint']] as const)
        .flatMap(([key, text, token]) => {
          const card = cardIn(host, STATUS_CASES[key].terminal.launchDirectory);
          const box = card ? tintedAncestor(holders(card, text)[0], card) : undefined;
          return paints(box ? getComputedStyle(box).backgroundColor : undefined, token, `${key} condition box`);
        })).toEqual([]);
    } finally { dispose(); }
  });

  it('mutes the ticket-line indications in --dim', () => {
    const { host, dispose } = mount(theme);
    try {
      expect(([[STATUS_CASES.unassigned.terminal, 'No flow run started'], [noTicket, 'No ticket'], [titleLoading, 'Title loading']] as const)
        .flatMap(([terminal, text]) => {
          const element = holders(cardIn(host, terminal.launchDirectory), text)[0];
          return paints(element ? getComputedStyle(element).color : undefined, '--dim', `"${text}"`);
        })).toEqual([]);
    } finally { dispose(); }
  });

  it('dashes the disconnected card border, and no connected card border', () => {
    const { host, dispose } = mount(theme);
    try {
      const borders = (key: StatusCaseKey) => {
        const card = cardIn(host, STATUS_CASES[key].terminal.launchDirectory);
        const style = card ? getComputedStyle(card) : undefined;
        return style ? [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle] : null;
      };
      const connected = borders('working');
      expect({ disconnected: borders('disconnected'), connected: connected?.some(side => side === 'dashed') ?? null })
        .toEqual({ disconnected: ['dashed', 'dashed', 'dashed', 'dashed'], connected: false });
    } finally { dispose(); }
  });

  it('sets body text, directories and the title in the Plex Sans, Plex Mono and Fraunces stacks', () => {
    const { host, dispose } = mount(theme);
    try {
      const { terminal } = STATUS_CASES.working;
      const card = cardIn(host, terminal.launchDirectory);
      const status = card ? statusRowIn(card) : null;
      const directory = holders(card, terminal.launchDirectory)[0];
      const title = windowTitleLocator(page.elementLocator(host)).query();
      const family = (element: Element | null | undefined) => (element ? stack(getComputedStyle(element).fontFamily) : null);
      expect({ body: family(status), directory: family(directory), title: family(title) }).toEqual({
        body: ['IBM Plex Sans', 'system-ui', 'sans-serif'],
        directory: ['IBM Plex Mono', 'ui-monospace', 'monospace'],
        title: ['Fraunces', 'Georgia', 'serif'],
      });
    } finally { dispose(); }
  });
});
