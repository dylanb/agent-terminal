import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { ControllerTerminal } from '../../src/shared/ipc';
import { mountControllerPanes } from '../helpers/controllerMount';
import { statusService, statusTerminal } from '../helpers/controllerStatusFixture';
import { cardIn, clearHistoryIn, dismissIn, historyIn, receivedNotificationIn, statusRowIn } from '../helpers/controllerCards';
import type { ClearOutcome } from '../helpers/controllerClear';
import '../helpers/rendererTokens';
import '../../src/renderer/src/styles.css';

const directory = '/fixed/worktree';
const entries = [
  { message: 'Newest receipt', receivedAt: 2000, count: 3 },
  { message: 'Earlier receipt', receivedAt: 1000, count: 2 },
];
const terminal = (): ControllerTerminal => ({ ...statusTerminal({ attention: { status: 'complete', reasons: ['Pending approval'] }, error: { reason: 'Build failed before Clear' } }), notifications: entries, latestNotification: entries[0] });
const settled = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
afterEach(() => { document.body.replaceChildren(); document.documentElement.removeAttribute('data-theme'); });

it.each(['light', 'dark'].flatMap(theme => ['body', 'nested'].map(placement => ({ theme, placement }))))('clears by keyboard in a narrow $theme card in $placement placement without activation or dismissal', async ({ theme, placement }) => {
  document.documentElement.dataset.theme = theme;
  const parent = document.createElement('section'); parent.style.width = '320px'; document.body.append(parent);
  const before = terminal(); const service = statusService([before]);
  const api = { ...service.api, async clearHistory(observed: ControllerTerminal): Promise<ClearOutcome> {
    if (observed.id !== before.id) return 'stale';
    service.publish([{ ...before, notifications: [], latestNotification: undefined }]); return 'cleared';
  } };
  const { host, dispose } = mountControllerPanes({ parent: placement === 'nested' ? parent : document.body, controller: api, oneColumn: true });
  try {
    const card = () => cardIn(host, directory)!;
    historyIn(card())!.click(); await settled();
    const clear = clearHistoryIn(card());
    expect.soft(clear?.checkVisibility()).toBe(true);
    if (clear) { clear.focus(); await userEvent.keyboard('{Enter}'); }
    await settled();
    expect.soft(receivedNotificationIn(card())).toBeUndefined();
    expect.soft(historyIn(card())?.textContent).toMatch(/History\s+0\s*\/\s*3/);
    expect.soft(card().innerText).not.toContain('Earlier receipt');
    expect.soft(statusRowIn(card())?.textContent).toMatch(/error/i);
    expect.soft(card().innerText).toContain('Build failed before Clear');
    expect.soft(card().innerText).toContain('Pending approval');
    expect.soft(service.activated).toEqual([]); expect.soft(service.dismissed).toEqual([]);
  } finally { dispose(); }
});

it('offers distinct Clear and Dismiss actions on a disconnected one-entry card', async () => {
  const before = { ...terminal(), status: 'disconnected' as const, notifications: entries.slice(0, 1) };
  const service = statusService([before]);
  const api = { ...service.api, async clearHistory(): Promise<ClearOutcome> {
    service.publish([{ ...before, notifications: [], latestNotification: undefined }]); return 'cleared';
  } };
  const { host, dispose } = mountControllerPanes({ controller: api });
  try {
    historyIn(cardIn(host, directory)!)!.click();
    clearHistoryIn(cardIn(host, directory)!)?.click(); await settled();
    const card = cardIn(host, directory)!;
    expect.soft(receivedNotificationIn(card)).toBeUndefined();
    expect.soft(historyIn(card)?.textContent).toMatch(/History\s+0\s*\/\s*3/);
    expect.soft(dismissIn(card)?.checkVisibility()).toBe(true);
    expect.soft(service.dismissed).toEqual([]);
    dismissIn(card)?.click(); await settled();
    expect.soft(cardIn(host, directory)).toBeUndefined();
  } finally { dispose(); }
});
