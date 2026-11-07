import { expect, test } from '@playwright/test';
import { historyGate, historyTerminalTarget } from './controllerNotificationHistoryHarness';
import { cardLocator, dismissLocator, historyLocator, statusRowLocator, timelineEntriesLocator, timelineLocator } from '../helpers/controllerCards';
import { notificationEntries, statusEntries } from '../helpers/controllerHistory';
import { controllerSnapshot, waitForConnections } from './controllerSnapshot';

test('real human gates keep one bound of three across kinds, newest first, with no History control and without deciding the gate', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const g = await historyGate();
  try {
    const second = await g.next(2); const third = await g.next(3); const fourth = await g.next(4);
    const timeline = await g.timeline();
    expect.soft(timeline.length).toBeLessThanOrEqual(3);
    expect.soft(notificationEntries({ timeline })[0]).toEqual({ ...fourth, count: 1 });
    expect.soft(notificationEntries({ timeline }).map(item => item.message)).not.toContain(g.first.message);
    expect.soft(timeline.map(item => item.receivedAt)).toEqual([...timeline.map(item => item.receivedAt)].sort((a, b) => b - a));
    const card = cardLocator(g.controller().page, g.repo);
    await expect.soft(historyLocator(card)).toHaveCount(0);
    await expect.soft(timelineEntriesLocator(card)).toHaveCount(timeline.length);
    await expect.soft(timelineLocator(card)).toContainText(fourth.message);
    await expect.soft(timelineLocator(card)).not.toContainText(g.first.message);
    expect.soft([second.message, third.message]).not.toContain(g.first.message);
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
    expect.soft((await g.state()).loop?.iteration).toBe(4);
  } finally { await g.dispose(); }
});

test('a real ended gate adds status entries as live status advances and never a second receipt of its message', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const g = await historyGate();
  try {
    await g.resolve();
    const card = cardLocator(g.controller().page, g.repo);
    await expect.soft(statusRowLocator(card)).not.toContainText(/human/i);
    await expect.poll(async () => statusEntries({ timeline: await g.timeline() }).length).toBeGreaterThan(0);
    expect.soft((await g.entries()).every(item => item.message === g.first.message && item.receivedAt === g.first.receivedAt && item.count === 1)).toBe(true);
  } finally { await g.dispose(); }
});

test('disconnect records Disconnected as the newest entry without presenting a historical gate as live', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const g = await historyGate();
  try {
    await g.disconnect();
    const card = cardLocator(g.controller().page, g.repo);
    await expect(statusRowLocator(card)).toHaveText('Disconnected');
    await expect.poll(async () => (await g.timeline())[0]).toMatchObject({ kind: 'status', text: expect.stringContaining('Disconnected') });
    await expect.soft(timelineEntriesLocator(card).first()).toContainText('Disconnected');
    await expect.soft(historyLocator(card)).toHaveCount(0);
    await expect.soft(dismissLocator(card)).toBeVisible();
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
  } finally { await g.dispose(); }
});

test('same-run reconnect shows the still-current real request once', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const g = await historyGate();
  try {
    const second = await g.next(2);
    await g.disconnect();
    await expect(statusRowLocator(cardLocator(g.controller().page, g.repo))).toHaveText('Disconnected');
    await g.reconnect(); await waitForConnections(g.controller().page, g.repo, 1);
    await expect.poll(async () => (await controllerSnapshot(g.controller().page)).find(t => t.launchDirectory === g.repo)?.work?.attention).toMatchObject({ status: 'complete' });
    const entries = await g.entries();
    expect.soft(entries[0]?.message).toBe(second.message);
    expect.soft(entries.filter(item => item.message === second.message)).toHaveLength(1);
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
  } finally { await g.dispose(); }
});

test('a condition ending during outage is not revived and earns no second receipt', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const g = await historyGate();
  try {
    await g.disconnect(); await g.resolve(); await g.reconnect();
    await waitForConnections(g.controller().page, g.repo, 1);
    await expect.poll(async () => (await controllerSnapshot(g.controller().page)).find(t => t.launchDirectory === g.repo)?.work?.flow).toMatchObject({ step: 'verify' });
    expect.soft(await g.entries()).toEqual([{ message: g.first.message, receivedAt: g.first.receivedAt, count: 1 }]);
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
      await expect.poll(async () => notificationEntries((await controllerSnapshot(g.controller().page)).find(t => t.launchDirectory === g.repo))[0]?.message).toBe(second.message);
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
    await expect.soft(timelineEntriesLocator(card)).toHaveCount(0);
    await expect.soft(historyLocator(card)).toHaveCount(0);
    const earliestReceipt = Date.now();
    await g.h.crash(peer.app); await waitForConnections(g.controller().page, g.repo, 1);
    const entries = await g.entries();
    expect.soft(entries).toEqual([{ message: g.first.message, receivedAt: expect.any(Number), count: 1 }]);
    await expect.soft.poll(async () => (await g.entries())[0]?.receivedAt).toBeGreaterThanOrEqual(earliestReceipt);
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
  } finally { await g.dispose(); }
});

test('a repeated real request shows its count exactly when it is above one, visually and in the accessibility tree', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const g = await historyGate();
  try {
    await g.disconnect();
    await expect(statusRowLocator(cardLocator(g.controller().page, g.repo))).toHaveText('Disconnected');
    await g.reconnect(); await waitForConnections(g.controller().page, g.repo, 1);
    await expect.poll(async () => (await controllerSnapshot(g.controller().page)).find(t => t.launchDirectory === g.repo)?.work?.attention).toMatchObject({ status: 'complete' });
    const card = cardLocator(g.controller().page, g.repo);
    const newest = (await g.entries())[0];
    const countText = new RegExp(`${newest?.count}\\s*(?:arrivals|times|×)|(?:×|received)\\s*${newest?.count}`, 'i');
    if ((newest?.count ?? 1) > 1) {
      expect.soft(await card.innerText()).toMatch(countText);
      expect.soft(await card.ariaSnapshot()).toMatch(countText);
    } else {
      expect.soft(await card.innerText()).not.toMatch(/\d+\s*(?:arrivals|×)/i);
    }
    expect.soft((await g.state()).loop?.humanNeeded).toBe(true);
  } finally { await g.dispose(); }
});
