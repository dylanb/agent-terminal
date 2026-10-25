import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';
import type { ControllerTerminal } from '../../src/shared/ipc';
import { accentIn, bringForwardIn, cardHeaderIn, cardIn, dismissIn, showFullReasonIn, statusRowIn, windowHeaderIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { STATUS_CASES, SUMMARY_LABELS, statusTerminal } from '../helpers/controllerStatusFixture';
import { readable } from '../helpers/readableText';
import { compositeOver, contrastRatio, parseColor, ringOver, type RGBA } from '../helpers/wcag';

function background(element: Element): RGBA {
  const layers: RGBA[] = [];
  for (let current: Element | null = element; current; current = current.parentElement) {
    const color = parseColor(getComputedStyle(current).backgroundColor);
    layers.push(color);
    if (color[3] === 1) break;
  }
  if (layers.at(-1)?.[3] !== 1) throw new Error('Contrast probe requires an opaque backdrop');
  return layers.reduceRight((behind, color) => compositeOver(color, behind));
}

function opacity(element: Element): number {
  let alpha = 1;
  for (let current: Element | null = element; current; current = current.parentElement) alpha *= Number(getComputedStyle(current).opacity);
  return alpha;
}

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/** The painted colour of each border edge, on the accent's ancestors up to its card, that the accent's box meets. */
function bordersTouching(accent: HTMLElement, card: HTMLElement): RGBA[] {
  const box = accent.getBoundingClientRect();
  const touching: RGBA[] = [];
  for (let node = accent.parentElement; node && card.contains(node); node = node.parentElement) {
    const style = getComputedStyle(node);
    const outer = node.getBoundingClientRect();
    for (const side of SIDES) {
      const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`));
      if (!(width > 0) || style.getPropertyValue(`border-${side}-style`) === 'none') continue;
      const inner = { top: outer.top + width, right: outer.right - width, bottom: outer.bottom - width, left: outer.left + width }[side];
      if (Math.abs(box[side] - inner) <= 0.5) touching.push(compositeOver(parseColor(style.getPropertyValue(`border-${side}-color`)), background(node)));
    }
  }
  return touching;
}

async function tabTo(target: HTMLElement | undefined): Promise<boolean> {
  for (let presses = 0; target && document.activeElement !== target && presses < 60; presses += 1) await userEvent.tab();
  return Boolean(target) && document.activeElement === target;
}

const terminals: ControllerTerminal[] = [
  { id: 'a', launchDirectory: '/l/a', repositoryRoot: '/l' },
  { id: 'b', launchDirectory: '/r/b', repositoryRoot: '/r' },
];
const LONG_REASON = ['Reason line 1', 'Reason line 2', 'Reason line 3', 'Reason line 4', 'Reason line 5'].join('\n');

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
});

const control = (host: HTMLElement, directory: string, find: (card: HTMLElement) => HTMLElement | undefined) => {
  const card = cardIn(host, directory);
  return card ? find(card) : undefined;
};

describe.each(['light', 'dark'])('controller panes in %s theme', theme => {
  function mount(items: ControllerTerminal[] = terminals) {
    document.documentElement.setAttribute('data-theme', theme);
    const { host, service, dispose } = mountControllerPanes({ terminals: items });
    return { host, activated: service.activated, publish: service.publish, component: { dispose } };
  }

  it.each([320, 900])('paints a readable error state distinct from a live card in a %ipx host', width => {
    const disconnected = { ...terminals[0], status: 'disconnected' as const };
    const { host, component } = mount([disconnected, terminals[1]]);
    host.style.width = `${width}px`;
    try {
      const card = cardIn(host, disconnected.launchDirectory);
      const status = card ? statusRowIn(card) : null;
      const behind = status ? background(status) : undefined;
      expect({
        identity: readable(host, disconnected.launchDirectory),
        status: status?.textContent?.trim(),
        statusReadable: Boolean(card && readable(host, 'Disconnected', card)),
        contrast: Boolean(status && behind && contrastRatio(ringOver(getComputedStyle(status).color, opacity(status), behind), behind) >= 4.5),
        overflow: host.scrollWidth - host.clientWidth,
      }).toEqual({ identity: true, status: 'Disconnected', statusReadable: true, contrast: true, overflow: 0 });
    } finally { component.dispose(); }
  });

  it.each([320, 900])('paints an accessible dismiss control and keyboard focus in a %ipx host', async width => {
    const { host, component } = mount([{ ...terminals[0], status: 'disconnected' }]);
    host.style.width = `${width}px`;
    try {
      const button = control(host, terminals[0].launchDirectory, dismissIn);
      const focused = await tabTo(button);
      const style = button ? getComputedStyle(button) : undefined;
      const box = button?.getBoundingClientRect();
      const hostBox = host.getBoundingClientRect();
      const behind = button ? background(button) : undefined;
      const ringBehind = button ? background(button.parentElement!) : undefined;
      expect.soft(Boolean(button && box && box.width > 0 && box.height > 0 &&
        box.left >= hostBox.left && box.right <= hostBox.right && readable(host, button.textContent ?? '') &&
        style && behind && contrastRatio(ringOver(style.color, opacity(button), behind), behind) >= 4.5), 'dismiss control is painted, readable and fits its host').toBe(true);
      expect.soft(Boolean(button && focused && style && ringBehind &&
        style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0 &&
        contrastRatio(ringOver(style.outlineColor, opacity(button), ringBehind), ringBehind) >= 3), 'dismiss control has visible keyboard focus').toBe(true);
    } finally { component.dispose(); }
  });

  it('brings a terminal forward through native keyboard interaction', async () => {
    const { host, activated, component } = mount();
    try {
      await tabTo(control(host, terminals[0].launchDirectory, bringForwardIn));
      await userEvent.keyboard('{Enter}');
      expect(activated).toEqual(['a']);
    } finally { component.dispose(); }
  });

  it.each([320, 900])('keeps identities painted and controls separated in a %ipx host', width => {
    const { host, component } = mount();
    host.style.width = `${width}px`;
    try {
      const hostBox = host.getBoundingClientRect();
      for (const terminal of terminals) expect.soft(readable(host, terminal.launchDirectory)).toBe(true);
      const buttons = terminals.map(terminal => control(host, terminal.launchDirectory, bringForwardIn));
      expect.soft(buttons.filter(Boolean)).toHaveLength(2);
      const present = buttons.filter((button): button is HTMLElement => Boolean(button));
      for (const [index, button] of present.entries()) {
        const box = button.getBoundingClientRect();
        expect.soft(box.width > 0 && box.height > 0 && box.left >= hostBox.left && box.right <= hostBox.right).toBe(true);
        for (const other of present.slice(index + 1)) {
          const next = other.getBoundingClientRect();
          expect.soft(box.right <= next.left || next.right <= box.left || box.bottom <= next.top || next.bottom <= box.top).toBe(true);
        }
      }
      expect.soft(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
    } finally { component.dispose(); }
  });

  it('keeps every painted text at 4.5:1 against what is behind it, for every status row and the empty state', async () => {
    const noTicket = { ...statusTerminal({ ticket: { availability: 'none' } }), id: 'no-ticket', launchDirectory: '/muted/no-ticket' };
    const titleLoading = { ...statusTerminal({ ticket: { availability: 'known', number: 219, title: { availability: 'loading' } } }), id: 'title-loading', launchDirectory: '/muted/title-loading' };
    const longHuman = { ...statusTerminal({ attention: { status: 'complete', reasons: [LONG_REASON] } }), id: 'long-human', launchDirectory: '/long/human' };
    const longError = { ...statusTerminal({ error: { reason: LONG_REASON } }), id: 'long-error', launchDirectory: '/long/error' };
    const cases = Object.values(STATUS_CASES);
    const { host, publish, component } = mount([...cases.map(c => c.terminal), noTicket, titleLoading, longHuman, longError]);
    const grade = (required: readonly string[]): string[] => gradeTexts(host, required);
    try {
      await vi.waitFor(() => {
        if (![longHuman, longError].every(t => control(host, t.launchDirectory, showFullReasonIn))) throw new Error('no Show full reason yet');
      }).catch(() => undefined);
      const withCards = grade([
        ...new Set(cases.map(c => c.text)), ...SUMMARY_LABELS,
        'No flow run started', 'No ticket', 'Title loading', 'Approve the plan', 'Step exited 1', 'Show full reason',
      ]);
      publish([]);
      expect({ withCards, empty: grade([...SUMMARY_LABELS, 'No terminals connected']) }).toEqual({ withCards: [], empty: [] });
    } finally { component.dispose(); }
  });

  it('keeps every collapsed header, with its compact status label, at 4.5:1 against what is behind it', () => {
    document.documentElement.setAttribute('data-theme', theme);
    const cases = Object.values(STATUS_CASES);
    const { host, dispose } = mountControllerPanes({ terminals: cases.map(c => c.terminal), oneColumn: true });
    const header = (directory: string) => { const card = cardIn(host, directory); return card ? cardHeaderIn(card, directory) : undefined; };
    try {
      for (const { terminal } of cases) if (header(terminal.launchDirectory)?.getAttribute('aria-expanded') === 'true') header(terminal.launchDirectory)?.click();
      expect(cases.flatMap(({ terminal, text }) => {
        const control = header(terminal.launchDirectory);
        if (!control) return [`${terminal.launchDirectory} has no header`];
        if (control.getAttribute('aria-expanded') !== 'false') return [`${terminal.launchDirectory} is not collapsed`];
        return gradeTexts(control, [text]).map(problem => `${terminal.launchDirectory}: ${problem}`);
      })).toEqual([]);
    } finally { dispose(); }
  });

  it('paints each card accent at 3:1 against the card and the window behind it', () => {
    const cases = Object.entries(STATUS_CASES);
    const { host, component } = mount(cases.map(([, c]) => c.terminal));
    try {
      const page = background(document.body);
      expect(cases.flatMap(([key, { terminal }]) => {
        const card = cardIn(host, terminal.launchDirectory);
        const accent = card ? accentIn(card) : null;
        if (!accent) return [`${key} has no accent`];
        const beside = background(accent.parentElement!);
        const painted = compositeOver(parseColor(getComputedStyle(accent).backgroundColor), beside);
        const against: [string, RGBA][] = [['card', beside], ['window', page], ...bordersTouching(accent, card!).map((colour): [string, RGBA] => ['border', colour])];
        return against.flatMap(([what, colour]) => {
          const ratio = contrastRatio(painted, colour);
          return ratio >= 3 ? [] : [`${key} accent at ${ratio.toFixed(2)} against the ${what}`];
        });
      })).toEqual([]);
    } finally { component.dispose(); }
  });

  it('paints a 3:1 keyboard focus ring on the card header, Bring forward, Dismiss and Show full reason', async () => {
    const disconnected = STATUS_CASES.disconnected.terminal;
    const blocked = statusTerminal({ attention: { status: 'complete', reasons: [LONG_REASON] } });
    const { host, component } = mount([STATUS_CASES.working.terminal, disconnected, blocked]);
    try {
      const working = STATUS_CASES.working.terminal.launchDirectory;
      const controls = {
        'card header': () => control(host, working, card => cardHeaderIn(card, working)),
        'Bring forward': () => control(host, working, bringForwardIn),
        Dismiss: () => control(host, disconnected.launchDirectory, dismissIn),
        'Show full reason': () => vi.waitFor(() => {
          const found = control(host, blocked.launchDirectory, showFullReasonIn);
          if (!found) throw new Error('no control yet');
          return found;
        }).catch(() => undefined),
      };
      const weak: string[] = [];
      for (const [name, find] of Object.entries(controls)) {
        const button = await find();
        if (!(await tabTo(button))) { weak.push(`${name} cannot be focused`); continue; }
        const style = getComputedStyle(button!);
        const behind = background(button!.parentElement!);
        const ratio = contrastRatio(ringOver(style.outlineColor, opacity(button!), behind), behind);
        if (style.outlineStyle === 'none' || !(Number.parseFloat(style.outlineWidth) > 0) || ratio < 3) weak.push(`${name} ring ${style.outlineStyle} ${style.outlineWidth} at ${ratio.toFixed(2)}`);
      }
      expect(weak).toEqual([]);
    } finally { component.dispose(); }
  });
});

describe.each(['aside', 'main'])('the controller organism placed in %s', tag => {
  it('shows the same header counts and status text', () => {
    const parent = document.createElement(tag);
    parent.style.width = tag === 'aside' ? '22rem' : '60rem';
    document.body.append(parent);
    const cases = [STATUS_CASES['needs-human'], STATUS_CASES.working];
    const { host, dispose } = mountControllerPanes({ terminals: cases.map(c => c.terminal), parent });
    try {
      const header = windowHeaderIn(host)?.textContent ?? '';
      expect({
        total: /(?<![\w-])2\s*(?:total|terminals?)\b|\b(?:total|terminals?)\W*2(?!\d)/i.test(header),
        statuses: cases.map(c => { const card = cardIn(host, c.terminal.launchDirectory); return card ? statusRowIn(card)?.textContent?.trim() : undefined; }),
      }).toEqual({ total: true, statuses: ['Needs a human', 'Working'] });
    } finally { dispose(); }
  });
});

/** Each painted text node in `root` under 4.5:1 against what is behind it, and each of `required` that no painted text
 *  node holds. */
function gradeTexts(root: HTMLElement, required: readonly string[]): string[] {
  const found: string[] = [];
  const graded: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement!;
    if (!node.textContent?.trim() || element.getClientRects().length === 0) continue;
    graded.push(node.textContent);
    const behind = background(element);
    const ratio = contrastRatio(ringOver(getComputedStyle(element).color, opacity(element), behind), behind);
    if (ratio < 4.5) found.push(`"${node.textContent.trim().slice(0, 40)}" at ${ratio.toFixed(2)}`);
  }
  const all = graded.join('\n');
  return [...found, ...required.filter(text => !all.includes(text)).map(text => `"${text}" was not graded`)];
}
