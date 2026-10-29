import { expect, test } from '@playwright/test';
import { historyGate, historyTerminalTarget } from './controllerNotificationHistoryHarness';
import { cardLocator, dismissLocator, historyLocator, receivedNotificationLocator, statusRowLocator } from '../helpers/controllerCards';
import { controllerSnapshot, waitForConnections } from './controllerSnapshot';

test('real human gates retain only three distinct notifications and expose initial History without deciding the gate', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const g = await historyGate();
  try {
    const second = await g.next(2); const third = await g.next(3); const fourth = await g.next(4);
    expect.soft(await g.entries()).toEqual([
      { ...fourth, count: 1 }, { ...third, count: 1 }, { ...second, count: 1 },
    ]);
    const card = cardLocator(g.controller().page, g.repo);
    const toggle = historyLocator(card);
    await expect.soft(toggle).toHaveText(/History\s+3\s*\/\s*3/i);
    if (await toggle.count()) await toggle.click();
    await expect.soft(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect.soft(card).toContainText(third.message);
    await expect.soft(card).toContainText(second.message);
    await expect.soft(card).not.toContainText(g.first.message);
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
    expect.soft((await g.state()).loop?.iteration).toBe(4);
  } finally { await g.dispose(); }
});

test('a real ended gate keeps its received message and first receipt while live status advances', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const g = await historyGate();
  try {
    await g.resolve();
    const card = cardLocator(g.controller().page, g.repo);
    await expect.soft(receivedNotificationLocator(card)).toContainText(g.first.message);
    expect.soft(await g.entries()).toEqual([{ ...g.first, count: 1 }]);
    await expect.soft(statusRowLocator(card)).not.toContainText(/human/i);
  } finally { await g.dispose(); }
});

test('disconnect retains visible history without presenting a historical gate as live', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const g = await historyGate();
  try {
    await g.disconnect();
    const card = cardLocator(g.controller().page, g.repo);
    await expect(statusRowLocator(card)).toHaveText('Disconnected');
    await expect.soft(receivedNotificationLocator(card)).toContainText(g.first.message);
    await expect.soft(historyLocator(card)).toHaveText(/History\s+1\s*\/\s*3/i);
    await expect.soft(dismissLocator(card)).toBeVisible();
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
  } finally { await g.dispose(); }
});

test('same-run reconnect reuses history and counts the still-current real request without changing its time', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const g = await historyGate();
  try {
    const second = await g.next(2);
    await g.disconnect();
    await expect(statusRowLocator(cardLocator(g.controller().page, g.repo))).toHaveText('Disconnected');
    await g.reconnect(); await waitForConnections(g.controller().page, g.repo, 1);
    await expect.poll(async () => (await controllerSnapshot(g.controller().page)).find(t => t.launchDirectory === g.repo)?.work?.attention).toMatchObject({ status: 'complete' });
    const entries = await g.entries();
    expect.soft(entries).toEqual([{ ...second, count: expect.any(Number) }, { ...g.first, count: 1 }]);
    expect.soft(entries[0]?.count).toBeGreaterThanOrEqual(2);
    const received = receivedNotificationLocator(cardLocator(g.controller().page, g.repo));
    const count = entries[0]?.count ?? 2;
    const countText = new RegExp(`${count}\\s*(?:arrivals|times|×)|(?:×|received)\\s*${count}`, 'i');
    expect.soft(await received.innerText()).toMatch(countText);
    expect.soft(await received.ariaSnapshot()).toMatch(countText);
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
  } finally { await g.dispose(); }
});

test('a condition ending during outage is not revived; earlier received context is retained', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const g = await historyGate();
  try {
    await g.disconnect(); await g.resolve(); await g.reconnect();
    await waitForConnections(g.controller().page, g.repo, 1);
    await expect.poll(async () => (await controllerSnapshot(g.controller().page)).find(t => t.launchDirectory === g.repo)?.work?.flow).toMatchObject({ step: 'verify' });
    expect.soft(await g.entries()).toEqual([{ ...g.first, count: 1 }]);
    await expect.soft(statusRowLocator(cardLocator(g.controller().page, g.repo))).not.toContainText(/human/i);
  } finally { await g.dispose(); }
});

for (const reset of ['restart', 'dismiss'] as const) {
  test(`${reset} forgets old context and rebuilds only the real current gate`, { tag: '@ownapp' }, async () => {
    test.setTimeout(180_000);
    const g = await historyGate();
    try {
      const second = await g.next(2); await g.disconnect();
      await expect(statusRowLocator(cardLocator(g.controller().page, g.repo))).toHaveText('Disconnected');
      if (reset === 'restart') await g.restartController();
      else await dismissLocator(cardLocator(g.controller().page, g.repo)).click();
      expect.soft(await controllerSnapshot(g.controller().page)).toEqual([]);
      const earliestReceipt = Date.now();
      await g.reconnect(); await waitForConnections(g.controller().page, g.repo, 1);
      await expect.poll(async () => (await controllerSnapshot(g.controller().page)).find(t => t.launchDirectory === g.repo)?.notifications?.[0]?.message).toBe(second.message);
      const entries = await g.entries();
      expect.soft(entries).toEqual([{ message: second.message, receivedAt: expect.any(Number), count: 1 }]);
      expect.soft(entries[0]?.receivedAt).toBeGreaterThanOrEqual(earliestReceipt);
      expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
    } finally { await g.dispose(); }
  });
}

test('overlap discards prior messages and rebuilds the surviving real gate as a fresh receipt', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const g = await historyGate();
  try {
    const peer = await g.h.launch(historyTerminalTarget, g.repo);
    await waitForConnections(g.controller().page, g.repo, 2);
    const card = cardLocator(g.controller().page, g.repo);
    await expect.soft(receivedNotificationLocator(card)).toHaveCount(0);
    await expect.soft(historyLocator(card)).toHaveCount(0);
    const earliestReceipt = Date.now();
    await g.h.crash(peer.app); await waitForConnections(g.controller().page, g.repo, 1);
    const entries = await g.entries();
    expect.soft(entries).toEqual([{ message: g.first.message, receivedAt: expect.any(Number), count: 1 }]);
    await expect.soft.poll(async () => (await g.entries())[0]?.receivedAt).toBeGreaterThanOrEqual(earliestReceipt);
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
  } finally { await g.dispose(); }
});

test('an older repeated real request exposes its count visually and in the accessibility tree', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const g = await historyGate();
  try {
    await g.disconnect();
    await expect(statusRowLocator(cardLocator(g.controller().page, g.repo))).toHaveText('Disconnected');
    await g.reconnect(); await waitForConnections(g.controller().page, g.repo, 1);
    await expect.poll(async () => (await controllerSnapshot(g.controller().page)).find(t => t.launchDirectory === g.repo)?.work?.attention).toMatchObject({ status: 'complete' });
    const repeatCount = Math.max(2, (await g.entries())[0]?.count ?? 2);
    await g.next(2);
    const card = cardLocator(g.controller().page, g.repo);
    const toggle = historyLocator(card);
    if (await toggle.count()) await toggle.click();
    const countText = new RegExp(`${repeatCount}\\s*(?:arrivals|times|×)|(?:×|received)\\s*${repeatCount}`, 'i');
    expect.soft(await card.innerText()).toMatch(countText);
    expect.soft(await card.ariaSnapshot()).toMatch(countText);
    expect.soft(await receivedNotificationLocator(card).innerText()).not.toMatch(countText);
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
  } finally { await g.dispose(); }
});
