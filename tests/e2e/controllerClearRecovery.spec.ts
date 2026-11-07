import { expect, test } from '@playwright/test';
import { historyGate, historyTerminalTarget } from './controllerNotificationHistoryHarness';
import { cardLocator, clearHistoryLocator, dismissLocator, historyLocator, statusRowLocator, timelineEntriesLocator, timelineLocator } from '../helpers/controllerCards';
import { controllerSnapshot, waitForConnections } from './controllerSnapshot';

test('cleared real gate stays empty after same-run reconnect and a new stop notifies', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const g = await historyGate();
  try {
    const card = cardLocator(g.controller().page, g.repo);
    await clearHistoryLocator(card).click();
    await expect.poll(async () => (await g.entries()).length).toBe(0);
    await g.disconnect(); await expect(statusRowLocator(card)).toHaveText('Disconnected');
    await g.reconnect(); await waitForConnections(g.controller().page, g.repo, 1);
    await expect.poll(async () => (await controllerSnapshot(g.controller().page)).find(t => t.launchDirectory === g.repo)?.work?.attention).toMatchObject({ status: 'complete' });
    expect.soft(await g.entries()).toEqual([]);
    await expect.soft(timelineLocator(card)).not.toContainText(g.first.message);
    await expect.soft(historyLocator(card)).toHaveCount(0);
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
    expect.soft((await g.state()).loop?.iteration).toBe(1);
    const next = await g.next(2);
    await expect.soft(timelineLocator(card)).toContainText(next.message);
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
  } finally { await g.dispose(); }
});

for (const reset of ['dismiss', 'restart', 'overlap'] as const) {
  test(`${reset} forgets a real gate's Clear and rebuilds its current notification afresh`, { tag: '@ownapp' }, async () => {
    test.setTimeout(180_000);
    const g = await historyGate();
    try {
      const card = () => cardLocator(g.controller().page, g.repo);
      await clearHistoryLocator(card()).click();
      await expect.poll(async () => (await g.entries()).length).toBe(0);
      const earliestReceipt = Date.now();
      if (reset === 'overlap') {
        const peer = await g.h.launch(historyTerminalTarget, g.repo);
        await waitForConnections(g.controller().page, g.repo, 2);
        await expect.soft(historyLocator(card())).toHaveCount(0);
        await expect.soft(timelineEntriesLocator(card())).toHaveCount(0);
        await g.h.crash(peer.app); await waitForConnections(g.controller().page, g.repo, 1);
      } else {
        await g.disconnect(); await expect(statusRowLocator(card())).toHaveText('Disconnected');
        if (reset === 'restart') await g.restartController();
        else await dismissLocator(card()).click();
        await expect.poll(() => controllerSnapshot(g.controller().page)).toEqual([]);
        await g.reconnect(); await waitForConnections(g.controller().page, g.repo, 1);
      }
      await expect.soft(timelineLocator(card())).toContainText(g.first.message);
      expect.soft(await g.entries()).toEqual([{ message: g.first.message, receivedAt: expect.any(Number), count: 1 }]);
      expect.soft((await g.entries())[0]?.receivedAt).toBeGreaterThanOrEqual(earliestReceipt);
      expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
      expect.soft((await g.state()).loop?.iteration).toBe(1);
    } finally { await g.dispose(); }
  });
}
