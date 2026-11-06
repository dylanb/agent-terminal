import { afterEach, expect, it } from 'vitest';
import { createControllerCard } from '../../src/renderer/src/controllerCard';
import { directoryCards, type ControllerDirectoryCard } from '../../src/shared/controllerCards';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusTerminal } from '../helpers/controllerStatusFixture';
import { notificationItem, statusItem } from '../helpers/controllerHistory';
import { bringForwardIn, cardHeaderIn, cardIn, dismissIn, historyIn, statusRowIn, timelineEntriesIn } from '../helpers/controllerCards';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';

const directory = '/fixed/worktree';
const timeline = [
  notificationItem('Newest proposal', new Date(2026, 9, 28, 15, 43).getTime()),
  statusItem('Went quiet between the proposals', new Date(2026, 9, 28, 14, 30).getTime()),
  notificationItem('Earlier proposal', new Date(2026, 9, 28, 13, 24).getTime(), 2),
];
const settled = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
afterEach(() => { document.body.replaceChildren(); document.documentElement.removeAttribute('data-theme'); });

it.each(['light', 'dark'])('an expanded card lists every timeline entry newest first with its time and no History control in the %s theme', async theme => {
  document.documentElement.dataset.theme = theme;
  const terminal = statusTerminal({ attention: { status: 'review', reasons: ['Live gate reason'] } });
  const card = { ...directoryCards([terminal])[0], timeline } as ControllerDirectoryCard;
  const host = document.createElement('main'); document.body.append(host);
  let activated = false;
  const component = createControllerCard(host, { card, expandedByDefault: true, onDismissLoopMessage() {}, onAction() { activated = true; } });
  try {
    const pane = cardIn(host, directory)!;
    const entries = timelineEntriesIn(pane);
    expect.soft(entries).toHaveLength(3);
    expect.soft(entries.every(entry => entry.checkVisibility())).toBe(true);
    const text = pane.innerText;
    expect.soft(text.indexOf('Newest proposal')).toBeLessThan(text.indexOf('Went quiet between the proposals'));
    expect.soft(text.indexOf('Went quiet between the proposals')).toBeLessThan(text.indexOf('Earlier proposal'));
    expect.soft(text).toMatch(/\b(?:15|3):43\b/);
    expect.soft(text).toMatch(/\b(?:14|2):30\b/);
    expect.soft(text).toMatch(/\b(?:13|1):24\b/);
    expect.soft(entries[2]?.innerText ?? '').toMatch(/2\s*(?:arrivals|times|×)|(?:×|received)\s*2/i);
    expect.soft(historyIn(pane)).toBeUndefined();
    expect.soft(statusRowIn(pane)?.textContent).toMatch(/human/i);
    expect.soft(activated).toBe(false);
  } finally { component.dispose(); }
});

it('lists a single entry and lists nothing for an empty timeline', async () => {
  const host = document.createElement('main'); document.body.append(host);
  const one = createControllerCard(host, { card: { ...directoryCards([statusTerminal()])[0], timeline: timeline.slice(0, 1) } as ControllerDirectoryCard, expandedByDefault: true, onDismissLoopMessage() {}, onAction() {} });
  try {
    expect.soft(timelineEntriesIn(cardIn(host, directory)!).map(entry => entry.innerText)).toEqual([expect.stringContaining('Newest proposal')]);
  } finally { one.dispose(); }
  const empty = createControllerCard(host, { card: { ...directoryCards([statusTerminal()])[0], timeline: [] } as ControllerDirectoryCard, expandedByDefault: true, onDismissLoopMessage() {}, onAction() {} });
  try {
    expect.soft(timelineEntriesIn(host)).toEqual([]);
  } finally { empty.dispose(); }
});

it.each(['body', 'nested'] as const)('projects disconnected history and preserves manual collapse in %s placement', async placement => {
  const parent = document.createElement('section'); document.body.append(parent);
  const terminal = { ...statusTerminal({ attention: { status: 'complete', reasons: ['Live gate reason'] } }), timeline };
  const { host, service, dispose } = mountControllerPanes({ parent: placement === 'nested' ? parent : document.body, terminals: [terminal] });
  try {
    cardHeaderIn(cardIn(host, directory)!, directory)?.click();
    const arrival = notificationItem('Arrival after manual collapse', timeline[0].receivedAt + 1000);
    service.publish([{ ...terminal, timeline: [arrival, ...timeline.slice(0, 2)] }]);
    await settled();
    expect.soft(cardHeaderIn(cardIn(host, directory)!, directory)?.getAttribute('aria-expanded')).toBe('false');
    cardHeaderIn(cardIn(host, directory)!, directory)?.click();
    expect.soft(timelineEntriesIn(cardIn(host, directory)!)[0]?.textContent ?? '').toContain('Arrival after manual collapse');
    service.publish([{ ...terminal, status: 'disconnected' }]);
    await settled();
    const pane = cardIn(host, directory)!;
    expect.soft(timelineEntriesIn(pane).map(entry => entry.textContent)).toEqual([
      expect.stringContaining('Newest proposal'), expect.stringContaining('Went quiet'), expect.stringContaining('Earlier proposal'),
    ]);
    expect.soft(statusRowIn(pane)?.textContent).toMatch(/Disconnected/i);
    expect.soft(pane.innerText).not.toContain('Live gate reason');
    expect.soft(bringForwardIn(pane)).toBeUndefined();
    expect.soft(dismissIn(pane)?.checkVisibility()).toBe(true);
    expect.soft(service.activated).toEqual([]);
  } finally { dispose(); parent.remove(); }
});

it('does not display or announce the timeline while a directory has overlapping terminals', async () => {
  const terminal = { ...statusTerminal(), timeline };
  const { host, service, dispose } = mountControllerPanes({ terminals: [terminal] });
  try {
    service.publish([terminal, { ...terminal, id: 'peer' }]);
    await settled();
    const pane = cardIn(host, directory)!;
    expect.soft(timelineEntriesIn(pane)).toEqual([]);
    expect.soft(pane.innerText).not.toContain('Newest proposal');
    expect.soft(host.querySelector('[role="status"]')?.textContent).not.toContain('Newest proposal');
  } finally { dispose(); }
});

it('displays the repeat count of a notification entry', async () => {
  const card = { ...directoryCards([statusTerminal()])[0], timeline: [notificationItem('Repeated proposal', 1000, 12)] };
  const host = document.createElement('main'); document.body.append(host);
  const component = createControllerCard(host, { card, expandedByDefault: true, onDismissLoopMessage() {}, onAction() {} });
  try {
    const [entry] = timelineEntriesIn(cardIn(host, directory)!);
    await expect.poll(() => entry?.checkVisibility() ? entry.innerText : '').toMatch(/12\s*(?:arrivals|times|×)|(?:×|received)\s*12/i);
  } finally { component.dispose(); }
});
