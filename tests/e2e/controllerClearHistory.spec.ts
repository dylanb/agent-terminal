import { expect, test } from '@playwright/test';
import { historyGate } from './controllerNotificationHistoryHarness';
import { cardLocator, clearHistoryLocator, historyLocator, receivedNotificationLocator, statusRowLocator } from '../helpers/controllerCards';

test('Clear removes received history while preserving the card and its real pending gate', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const g = await historyGate();
  try {
    await g.next(2);
    const card = cardLocator(g.controller().page, g.repo);
    await historyLocator(card).click();
    const clear = clearHistoryLocator(card);
    await expect.soft(clear).toBeVisible();
    if (await clear.count()) await clear.click();
    await expect.soft(receivedNotificationLocator(card)).toHaveCount(0);
    await expect.soft(historyLocator(card)).toHaveText(/History\s+0\s*\/\s*3/);
    expect.soft(await g.entries()).toEqual([]);
    await expect.soft(statusRowLocator(card)).toContainText(/human/i);
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
    expect.soft((await g.state()).loop?.iteration).toBe(2);
  } finally { await g.dispose(); }
});

test('open History survives a real new gate notification, then Clear preserves that pending gate', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const g = await historyGate();
  try {
    const card = cardLocator(g.controller().page, g.repo);
    await historyLocator(card).click();
    await g.next(2);
    await expect.soft(historyLocator(card)).toHaveAttribute('aria-expanded', 'true');
    await expect.soft(clearHistoryLocator(card)).toBeVisible();
    if (await historyLocator(card).getAttribute('aria-expanded') !== 'true') await historyLocator(card).click();
    await clearHistoryLocator(card).click();
    await expect.soft(receivedNotificationLocator(card)).toHaveCount(0);
    await expect.soft(historyLocator(card)).toHaveText(/History\s+0\s*\/\s*3/);
    await expect.soft(statusRowLocator(card)).toContainText(/human/i);
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
    expect.soft((await g.state()).loop?.iteration).toBe(2);
  } finally { await g.dispose(); }
});
