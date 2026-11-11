import { expect, test } from '@playwright/test';
import { historyGate } from './controllerNotificationHistoryHarness';
import { cardLocator, clearHistoryLocator, historyLocator, statusRowLocator, timelineLocator } from '../helpers/controllerCards';

test('Clear removes the timeline with no History press while preserving the card and its real pending gate', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const g = await historyGate();
  try {
    const second = await g.next(2);
    const card = cardLocator(g.controller().page, g.repo);
    await expect.soft(historyLocator(card)).toHaveCount(0);
    const clear = clearHistoryLocator(card);
    await expect.soft(clear).toBeVisible();
    if (await clear.count()) await clear.click();
    await expect.poll(async () => (await g.entries()).length).toBe(0);
    await expect.soft(timelineLocator(card)).not.toContainText(second.message);
    await expect.soft(statusRowLocator(card)).toContainText(/human/i);
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
    expect.soft((await g.state()).loop?.iteration).toBe(2);
  } finally { await g.dispose(); }
});

test('Clear stays available after a real new gate notification, then preserves that pending gate', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const g = await historyGate();
  try {
    const card = cardLocator(g.controller().page, g.repo);
    await expect.soft(clearHistoryLocator(card)).toBeVisible();
    const second = await g.next(2);
    await expect.soft(clearHistoryLocator(card)).toBeVisible();
    await clearHistoryLocator(card).click();
    await expect.poll(async () => (await g.entries()).length).toBe(0);
    await expect.soft(timelineLocator(card)).not.toContainText(second.message);
    await expect.soft(statusRowLocator(card)).toContainText(/human/i);
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
    expect.soft((await g.state()).loop?.iteration).toBe(2);
  } finally { await g.dispose(); }
});
