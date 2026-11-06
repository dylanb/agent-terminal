import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { ControllerTerminal, ControllerClearTarget, ControllerClearOutcome } from '../../src/shared/ipc';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusService, statusTerminal } from '../helpers/controllerStatusFixture';
import { cardIn, clearHistoryIn, dismissIn, historyIn, statusRowIn, timelineEntriesIn } from '../helpers/controllerCards';
import { notificationItem, statusItem } from '../helpers/controllerHistory';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';

const directory = '/fixed/worktree';
const entries = [notificationItem('Newest receipt', 2000, 3), statusItem('Earlier status change', 1000)];
const terminal = (): ControllerTerminal => ({ ...statusTerminal({ activity: 'quiet', attention: { status: 'complete', reasons: ['Pending approval'] }, error: { reason: 'Build failed before Clear' } }), timeline: entries, clearHistoryTarget: { id: 'history-target', launchDirectory: directory, revision: 'initial' } });
const settled = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
afterEach(() => { document.body.replaceChildren(); document.documentElement.removeAttribute('data-theme'); });

it.each(['light', 'dark'].flatMap(theme => ['body', 'nested'].map(placement => ({ theme, placement }))))('clears by keyboard in a narrow $theme card in $placement placement without activation or dismissal', async ({ theme, placement }) => {
  document.documentElement.dataset.theme = theme;
  const parent = document.createElement('section'); parent.style.width = '320px'; document.body.append(parent);
  const before = terminal(); const service = statusService([before]);
  const api = { ...service.api, async clearHistory(observed: ControllerClearTarget): Promise<ControllerClearOutcome> {
    if (observed.revision !== before.clearHistoryTarget!.revision) return 'stale';
    service.publish([{ ...before, timeline: [] }]); return 'cleared';
  } };
  const { host, dispose } = mountControllerPanes({ parent: placement === 'nested' ? parent : document.body, controller: api, oneColumn: true });
  try {
    const card = () => cardIn(host, directory)!;
    const clear = clearHistoryIn(card());
    expect.soft(clear?.checkVisibility()).toBe(true);
    if (clear) { clear.focus(); await userEvent.keyboard('{Enter}'); }
    await settled();
    expect.soft(timelineEntriesIn(card())).toEqual([]);
    expect.soft(clearHistoryIn(card())).toBeUndefined();
    expect.soft(historyIn(card())).toBeUndefined();
    expect.soft(card().innerText).not.toContain('Earlier status change');
    expect.soft(statusRowIn(card())?.textContent).toMatch(/error/i);
    expect.soft(card().innerText).toContain('Build failed before Clear');
    expect.soft(card().innerText).toContain('Pending approval');
    expect.soft(service.activated).toEqual([]); expect.soft(service.dismissed).toEqual([]);
  } finally { dispose(); }
});

it('offers distinct Clear and Dismiss actions on a disconnected one-entry card, with Clear shown without any History press', async () => {
  const before = { ...terminal(), status: 'disconnected' as const, timeline: entries.slice(0, 1) };
  const service = statusService([before]);
  const api = { ...service.api, async clearHistory(): Promise<ControllerClearOutcome> {
    service.publish([{ ...before, timeline: [] }]); return 'cleared';
  } };
  const { host, dispose } = mountControllerPanes({ controller: api });
  try {
    const clear = clearHistoryIn(cardIn(host, directory)!);
    expect(clear?.checkVisibility()).toBe(true);
    clear!.click(); await settled();
    const card = cardIn(host, directory)!;
    expect.soft(timelineEntriesIn(card)).toEqual([]);
    expect.soft(clearHistoryIn(card)).toBeUndefined();
    expect.soft(dismissIn(card)?.checkVisibility()).toBe(true);
    expect.soft(service.dismissed).toEqual([]);
    dismissIn(card)?.click(); await settled();
    expect.soft(cardIn(host, directory)).toBeUndefined();
  } finally { dispose(); }
});

it.each(['body', 'nested'] as const)('passes the supplied Clear target unchanged in %s placement', async placement => {
  const target = { id: 'history-identity-independent-of-activation', launchDirectory: directory, revision: 'observed-history' };
  const before = { ...terminal(), clearHistoryTarget: target };
  const service = statusService([before]);
  const parent = document.createElement('section'); document.body.append(parent);
  let requested: unknown;
  const api = { ...service.api, async clearHistory(observed: ControllerClearTarget): Promise<ControllerClearOutcome> {
    requested = observed;
    return 'unavailable';
  } };
  const { host, dispose } = mountControllerPanes({ parent: placement === 'nested' ? parent : document.body, controller: api });
  try {
    clearHistoryIn(cardIn(host, directory)!)?.click(); await settled();
    expect(requested).toEqual(target);
    expect(service.activated).toEqual([]);
  } finally { dispose(); parent.remove(); }
});
