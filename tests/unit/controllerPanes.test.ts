// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControllerTerminal } from '../../src/shared/ipc';
import { bringForwardIn, cardIn, cardsIn, dismissIn, headerLabels, showsName, unshownCounts, windowHeaderIn, windowTitleIn } from '../helpers/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { STATUS_CASES, statusService } from '../helpers/controllerStatusFixture';

const terminal: ControllerTerminal = { id: 'terminal-a', launchDirectory: '/left/project/nested', repositoryRoot: '/left/project' };

afterEach(() => document.body.replaceChildren());

function placement(tag: string): HTMLElement {
  const parent = document.createElement(tag);
  document.body.append(parent);
  return parent;
}

describe('controller window header', () => {
  it('shows the title, the terminal counts and the four summary labels counting every status row', () => {
    const cases = Object.values(STATUS_CASES);
    const { host, dispose } = mountControllerPanes({ terminals: cases.map(c => c.terminal) });
    try {
      const header = windowHeaderIn(host);
      const text = header?.textContent ?? '';
      const connected = cases.filter(c => c.terminal.status !== 'disconnected').length;
      const counts = headerLabels(label => cases.filter(c => c.summary === label).length, cases.length, connected);
      expect([
        ...(header && windowTitleIn(header) ? [] : ['no "Controller" heading']),
        ...unshownCounts(text, counts),
      ]).toEqual([]);
    } finally { dispose(); }
  });

  it('shows every count as 0 and the launch-order guidance when there are no terminals', () => {
    const { host, dispose } = mountControllerPanes({ terminals: [] });
    try {
      const text = windowHeaderIn(host)?.textContent ?? '';
      expect([
        ...unshownCounts(text, headerLabels(() => 0, 0, 0)),
        ...(/no terminals connected.*launch.*terminal.*controller.*running/i.test(host.textContent ?? '') ? [] : ['no launch-order guidance']),
      ]).toEqual([]);
    } finally { dispose(); }
  });
});

describe('controller window header with empty classes', () => {
  it('shows 0 for each summary class with no cards', () => {
    const cases = [STATUS_CASES['needs-human'], STATUS_CASES.working, STATUS_CASES['working-activity-unavailable']];
    const { host, dispose } = mountControllerPanes({ terminals: cases.map(c => c.terminal) });
    try {
      const text = windowHeaderIn(host)?.textContent ?? '';
      expect(unshownCounts(text, headerLabels(label => cases.filter(c => c.summary === label).length, 3, 3))).toEqual([]);
    } finally { dispose(); }
  });
});

describe('controller panes', () => {
  it.each(['aside', 'main'])('identifies the card by its name and launch directory when mounted in %s', tag => {
    const { host, dispose } = mountControllerPanes({ terminals: [terminal], parent: placement(tag) });
    try {
      const card = cardIn(host, terminal.launchDirectory);
      expect({ card: Boolean(card), name: showsName(card, terminal.launchDirectory, 'project') }).toEqual({ card: true, name: true });
    } finally { dispose(); }
  });

  it.each(['aside', 'main'])('retains an accessible disconnected identity without Bring forward in %s', tag => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [terminal], parent: placement(tag) });
    try {
      service.publish([{ ...terminal, status: 'disconnected' }]);
      const card = cardIn(host, terminal.launchDirectory);
      expect({
        card: Boolean(card),
        name: showsName(card, terminal.launchDirectory, 'project'),
        disconnected: /disconnected/i.test(card?.textContent ?? ''),
        bringForward: card ? Boolean(bringForwardIn(card)) : false,
        empty: /no terminals connected/i.test(host.textContent ?? ''),
      }).toEqual({ card: true, name: true, disconnected: true, bringForward: false, empty: false });
    } finally { dispose(); }
  });

  it('renders a non-Git launch as directory data', () => {
    const directory = '/tmp/<img src=x onerror=alert(1)>';
    const { host, dispose } = mountControllerPanes({ terminals: [{ id: 'non-git', launchDirectory: directory, repositoryRoot: null }] });
    try {
      expect.soft(host.textContent).toContain(directory);
      expect.soft(host.querySelector('img')).toBeNull();
      expect.soft(host.textContent).not.toContain('Repository:');
    } finally { dispose(); }
  });

  it('brings forward the chosen opaque terminal identity even for equal directories', async () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [terminal, { ...terminal, id: 'terminal-b' }] });
    try {
      const second = cardsIn(host)[1];
      (second && bringForwardIn(second))?.click();
      await vi.waitFor(() => expect({ cards: cardsIn(host).length, activated: service.activated }).toEqual({ cards: 2, activated: ['terminal-b'] }));
    } finally { dispose(); }
  });

  it('announces unavailable activation without removing a still-connected card', async () => {
    const { host, dispose } = mountControllerPanes({ controller: statusService([terminal], { activation: 'unavailable' }).api });
    try {
      const card = cardIn(host, terminal.launchDirectory);
      (card && bringForwardIn(card))?.click();
      await vi.waitFor(() => expect({
        message: host.querySelector('[role="alert"]')?.textContent ?? '',
        cards: cardsIn(host).length,
      }).toEqual({ message: expect.stringMatching(/terminal unavailable/i), cards: 1 }));
    } finally { dispose(); }
  });

  it('explains the empty state when no terminal has registered', () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [terminal] });
    try {
      service.publish([]);
      expect.soft(host.textContent).toMatch(/no terminals (?:are )?connected/i);
      expect.soft(host.textContent).toMatch(/launch.*terminal.*controller.*running/i);
    } finally { dispose(); }
  });

  it.each([true, false])('keeps a usable focus target when the focused card disconnects (live peer: %s)', livePeer => {
    const survivor = { ...terminal, id: 'survivor', launchDirectory: '/right/project' };
    const { host, service, dispose } = mountControllerPanes({ terminals: livePeer ? [terminal, survivor] : [terminal] });
    try {
      const card = cardIn(host, terminal.launchDirectory);
      (card && bringForwardIn(card))?.focus();
      const disconnected = { ...terminal, status: 'disconnected' as const };
      service.publish(livePeer ? [disconnected, survivor] : [disconnected]);
      const focused = document.activeElement as HTMLElement;
      expect.soft(host.contains(focused)).toBe(true);
      expect.soft(focused.matches(':disabled, [aria-disabled="true"]')).toBe(false);
      expect(focused.getAttribute('aria-label') ?? focused.textContent).toMatch(livePeer ? /disconnected|dismiss|\/right\/project/i : /disconnected|dismiss/i);
    } finally { dispose(); }
  });

  it('removes its DOM and cannot render later service updates after disposal', () => {
    const { host, service, dispose } = mountControllerPanes({ terminals: [terminal] });
    dispose();
    service.publish([{ ...terminal, id: 'later' }]);
    expect(host.childElementCount).toBe(0);
  });

  it('does not steal focus from outside when a terminal disconnects', () => {
    const outside = document.createElement('button');
    outside.textContent = 'Settings';
    const survivor = { ...terminal, id: 'survivor' };
    const { service, dispose } = mountControllerPanes({ terminals: [terminal, survivor] });
    document.body.append(outside);
    try {
      outside.focus();
      service.publish([survivor]);
      expect(document.activeElement).toBe(outside);
    } finally { dispose(); }
  });

  it.each(['unavailable', 'rejected'] as const)('does not render a pending %s activation after disposal', async outcome => {
    let resolve!: (value: 'unavailable') => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<'unavailable'>((done, fail) => { resolve = done; reject = fail; });
    const requested: string[] = [];
    const { host, dispose } = mountControllerPanes({ controller: {
      subscribeTerminals(listener) { listener([terminal]); return () => {}; },
      activateTerminal(id) { requested.push(id); return pending; },
      async dismissTerminal() {},
    } });
    const card = cardIn(host, terminal.launchDirectory);
    (card && bringForwardIn(card))?.click();
    dispose();
    if (outcome === 'unavailable') resolve('unavailable');
    else reject(new Error('Connection closed'));
    await pending.catch(() => {});
    expect({ requested, children: host.childElementCount }).toEqual({ requested: [terminal.id], children: 0 });
  });
});

describe('dismiss disconnected cards', () => {
  it.each(['aside', 'main'])('dismisses the selected occurrence from %s without activating it', async tag => {
    const stale = { ...terminal, status: 'disconnected' as const };
    const { host, service, dispose } = mountControllerPanes({ terminals: [stale], parent: placement(tag) });
    try {
      const card = cardIn(host, terminal.launchDirectory);
      (card && dismissIn(card))?.click();
      await Promise.resolve();
      expect.soft(service.dismissed).toEqual([terminal.id]);
      expect.soft(service.activated).toEqual([]);
      expect.soft(host.textContent).toMatch(/no terminals connected.*launch.*terminal/i);
    } finally { dispose(); }
  });

  it.each([true, false])('moves focus after dismissal to a usable target (live peer: %s)', async livePeer => {
    const survivor = { ...terminal, id: 'survivor', launchDirectory: '/other' };
    const stale = { ...terminal, status: 'disconnected' as const };
    const { host, dispose } = mountControllerPanes({ terminals: livePeer ? [stale, survivor] : [stale] });
    try {
      const card = cardIn(host, terminal.launchDirectory);
      const dismiss = card ? dismissIn(card) : undefined;
      dismiss?.focus();
      dismiss?.click();
      await Promise.resolve();
      const focused = document.activeElement as HTMLElement;
      const name = focused.getAttribute('aria-label') ?? focused.textContent ?? '';
      expect(host.contains(focused) && !focused.matches(':disabled') &&
        (livePeer ? name.includes('/other') : /launch.*terminal/i.test(name))).toBe(true);
    } finally { dispose(); }
  });
});
