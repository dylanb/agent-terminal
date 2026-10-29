import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { createControllerCard } from '../../src/renderer/src/controllerCard';
import { directoryCards, type ControllerDirectoryCard } from '../../src/shared/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusTerminal } from '../helpers/controllerStatusFixture';
import { type ReceivedEntry } from '../helpers/controllerHistory';
import { bringForwardIn, cardHeaderIn, cardIn, dismissIn, historyIn, receivedNotificationIn, statusRowIn } from '../helpers/controllerCards';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';

const directory = '/fixed/worktree';
const notifications: ReceivedEntry[] = [
  { message: 'Newest proposal', receivedAt: new Date(2026, 9, 28, 15, 43).getTime(), count: 1 },
  { message: 'Earlier proposal', receivedAt: new Date(2026, 9, 28, 13, 24).getTime(), count: 2 },
  { message: 'Oldest retained proposal', receivedAt: new Date(2026, 9, 28, 10, 17).getTime(), count: 1 },
];
const settled = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
afterEach(() => { document.body.replaceChildren(); document.documentElement.removeAttribute('data-theme'); });

it.each(['light', 'dark'].flatMap(theme => ['pointer', 'Enter', 'Space'].map(input => ({ theme, input }))))('initial History control reveals ordered entries via $input in $theme', async ({ theme, input }) => {
  document.documentElement.dataset.theme = theme;
  const terminal = statusTerminal({ attention: { status: 'review', reasons: ['Live gate reason'] } });
  const card: ControllerDirectoryCard & { notifications: ReceivedEntry[] } = {
    ...directoryCards([terminal])[0], notifications,
  };
  const host = document.createElement('main'); document.body.append(host);
  let activated = false;
  const component = createControllerCard(host, { card, expandedByDefault: true, onDismissLoopMessage() {}, onAction() { activated = true; } });
  try {
    const pane = cardIn(host, directory)!;
    const toggle = historyIn(pane);
    expect.soft(toggle?.textContent ?? '').toMatch(/History\s+3\s*\/\s*3/i);
    expect.soft(toggle?.getAttribute('aria-expanded')).toBe('false');
    const use = async () => {
      if (!toggle) return;
      if (input === 'pointer') await userEvent.click(toggle);
      else { toggle.focus(); await userEvent.keyboard(input === 'Enter' ? '{Enter}' : ' '); }
      await settled();
    };
    expect.soft(pane.innerText).not.toContain('Earlier proposal');
    await use();
    expect.soft(toggle?.getAttribute('aria-expanded')).toBe('true');
    const text = pane.innerText;
    expect.soft(text).toContain('Earlier proposal');
    expect.soft(text).toContain('Oldest retained proposal');
    expect.soft(text.indexOf('Earlier proposal')).toBeLessThan(text.indexOf('Oldest retained proposal'));
    expect.soft(text).toMatch(/\b(?:13|1):24\b/);
    expect.soft(text).toMatch(/\b10:17\b/);
    expect.soft(pane.innerText).toMatch(/2\s*(?:arrivals|times|×)|(?:×|received)\s*2/i);
    expect.soft(receivedNotificationIn(pane)?.textContent ?? '').not.toContain('Earlier proposal');
    expect.soft(receivedNotificationIn(pane)?.textContent ?? '').toContain('Newest proposal');
    expect.soft(statusRowIn(pane)?.textContent).toMatch(/human/i);
    await use();
    expect.soft(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect.soft(pane.innerText).not.toContain('Earlier proposal');
    expect.soft(pane.innerText).not.toContain('Oldest retained proposal');
    expect.soft(activated).toBe(false);
  } finally { component.dispose(); }
});

it('History reports zero retained entries and has no received message', async () => {
  const card = { ...directoryCards([statusTerminal()])[0], notifications: [] };
  const host = document.createElement('main'); document.body.append(host);
  const component = createControllerCard(host, { card, expandedByDefault: true, onDismissLoopMessage() {}, onAction() {} });
  try {
    const pane = cardIn(host, directory)!;
    expect.soft(historyIn(pane)?.textContent ?? '').toMatch(/History\s+0\s*\/\s*3/i);
    historyIn(pane)?.click(); await settled();
    expect.soft(pane.innerText).not.toContain('Earlier proposal');
    expect.soft(receivedNotificationIn(pane)).toBeUndefined();
  } finally { component.dispose(); }
});

it('History reports one retained entry and has no earlier messages', async () => {
  const card = { ...directoryCards([statusTerminal()])[0], notifications: notifications.slice(0, 1) };
  const host = document.createElement('main'); document.body.append(host);
  const component = createControllerCard(host, { card, expandedByDefault: true, onDismissLoopMessage() {}, onAction() {} });
  try {
    const pane = cardIn(host, directory)!;
    expect.soft(historyIn(pane)?.textContent ?? '').toMatch(/History\s+1\s*\/\s*3/i);
    historyIn(pane)?.click(); await settled();
    expect.soft(pane.innerText).not.toContain('Earlier proposal');
    expect.soft(receivedNotificationIn(pane)?.textContent ?? '').toContain('Newest proposal');
  } finally { component.dispose(); }
});

it.each(['body', 'nested'] as const)('projects disconnected history and preserves manual collapse in %s placement', async placement => {
  const parent = document.createElement('section'); document.body.append(parent);
  const terminal = { ...statusTerminal({ attention: { status: 'complete', reasons: ['Live gate reason'] } }), notifications };
  const { host, service, dispose } = mountControllerPanes({ parent: placement === 'nested' ? parent : document.body, terminals: [terminal] });
  try {
    cardHeaderIn(cardIn(host, directory)!, directory)?.click();
    const arrival = { message: 'Arrival after manual collapse', receivedAt: notifications[0].receivedAt + 1000, count: 1 };
    const refreshed = { ...terminal, notifications: [arrival, ...notifications.slice(0, 2)] };
    service.publish([refreshed]);
    await settled();
    expect.soft(cardHeaderIn(cardIn(host, directory)!, directory)?.getAttribute('aria-expanded')).toBe('false');
    cardHeaderIn(cardIn(host, directory)!, directory)?.click();
    expect.soft(receivedNotificationIn(cardIn(host, directory)!)?.textContent ?? '').toContain('Arrival after manual collapse');
    expect.soft(historyIn(cardIn(host, directory)!)?.textContent ?? '').toMatch(/History\s+3\s*\/\s*3/i);
    service.publish([{ ...terminal, status: 'disconnected' }]);
    await settled();
    const pane = cardIn(host, directory)!;
    expect.soft(receivedNotificationIn(pane)?.textContent ?? '').toContain('Newest proposal');
    expect.soft(historyIn(pane)?.textContent ?? '').toMatch(/History\s+3\s*\/\s*3/i);
    expect.soft(statusRowIn(pane)?.textContent).toMatch(/Disconnected/i);
    expect.soft(pane.innerText).not.toContain('Live gate reason');
    expect.soft(bringForwardIn(pane)).toBeUndefined();
    expect.soft(dismissIn(pane)?.checkVisibility()).toBe(true);
    expect.soft(service.activated).toEqual([]);
  } finally { dispose(); parent.remove(); }
});

it('does not display or announce history while a directory has overlapping terminals', async () => {
  const terminal = { ...statusTerminal(), notifications };
  const { host, service, dispose } = mountControllerPanes({ terminals: [terminal] });
  try {
    service.publish([terminal, { ...terminal, id: 'peer' }]);
    await settled();
    const pane = cardIn(host, directory)!;
    expect.soft(historyIn(pane)).toBeUndefined();
    expect.soft(receivedNotificationIn(pane)).toBeUndefined();
    expect.soft(pane.innerText).not.toContain('Newest proposal');
    expect.soft(host.querySelector('[role="status"]')?.textContent).not.toContain('Newest proposal');
  } finally { dispose(); }
});

it('displays the latest entry repeat count in the received notification', async () => {
  const latest = { ...notifications[0], count: 12 };
  const card = { ...directoryCards([statusTerminal()])[0], notifications: [latest] };
  const host = document.createElement('main'); document.body.append(host);
  const component = createControllerCard(host, { card, expandedByDefault: true, onDismissLoopMessage() {}, onAction() {} });
  try {
    const received = receivedNotificationIn(cardIn(host, directory)!);
    await expect.poll(() => received?.checkVisibility() ? received.innerText : '').toMatch(/12\s*(?:arrivals|times|×)|(?:×|received)\s*12/i);
  } finally { component.dispose(); }
});
