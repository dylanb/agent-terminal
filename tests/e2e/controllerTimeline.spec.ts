import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { heldHumanGate, type HeldHumanGate } from './autoGateHarness';
import { cardHeaderLocator, cardLocator, historyLocator, timelineEntriesLocator } from '../helpers/controllerCards';
import { timelineOf } from '../helpers/controllerHistory';
import type { ControllerTerminal } from '../../src/shared/ipc';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
type RecordingWindow = Window & { timelineUpdates?: ControllerTerminal[][] };

test('a real terminal that went idle and then needed a human lists the request above the idle entry, and the next flow step is a newest entry', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const h = await createControllerDesktopHarness();
  let gate: HeldHumanGate | undefined;
  try {
    gate = heldHumanGate(h.fixture, 'controller-timeline');
    const repo = gate.repo;
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const terminal = await h.launch(terminalTarget, repo);
    await gate.start(terminal.page);
    const card = cardLocator(controller.page, repo);
    const header = cardHeaderLocator(card, repo);
    if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
    const entries = timelineEntriesLocator(card);
    const read = async () => {
      const texts = await entries.allInnerTexts();
      const kinds = await Promise.all(texts.map((_, index) => entries.nth(index).ariaSnapshot().then(snapshot => /notification/i.test(snapshot))));
      return { texts, kinds };
    };

    await expect.poll(async () => {
      const { texts, kinds } = await read();
      return texts.length > 0 && !kinds[0] && /idle/i.test(texts[0]);
    }, { timeout: 60_000 }).toBe(true);
    // The stop also asks the agent why, which marks it Working within moments of the request and lets the bound of
    // three evict the Idle entry, so the order is read from the first published timeline that holds the request.
    await controller.page.evaluate(() => {
      const updates: ControllerTerminal[][] = [];
      (window as RecordingWindow).timelineUpdates = updates;
      window.controller.subscribeTerminals(items => { updates.push(items); });
    });
    await gate.release();
    const source = await terminal.page.evaluate(directory => window.flow.state(directory), repo);
    expect(source.loop?.humanNeeded).toBe(true);
    const status = source.loop!.status;
    const firstTimelineWithRequest = async () => (await controller.page.evaluate(() => (window as RecordingWindow).timelineUpdates ?? []))
      .map(items => timelineOf(items.find(item => item.launchDirectory === repo)))
      .find(timeline => timeline.some(entry => entry.kind === 'notification' && entry.message.includes(status)));
    await expect.poll(firstTimelineWithRequest, { timeout: 60_000 }).toBeDefined();
    const timeline = (await firstTimelineWithRequest())!;
    expect.soft(timeline[0]).toMatchObject({ kind: 'notification', message: expect.stringContaining(status) });
    expect.soft(timeline.slice(1)).toContainEqual(expect.objectContaining({ kind: 'status', text: 'Idle' }));
    await expect.soft(entries.filter({ hasText: status })).toHaveCount(1);
    await expect.soft(historyLocator(card)).toHaveCount(0);
    for (const entry of await entries.all()) await expect.soft(entry.locator('time')).toHaveCount(1);

    const approve = terminal.page.locator('#loop-panel [data-gate-option="approve"]');
    const readout = terminal.page.locator('#flow-strip .loopstat');
    if (await readout.getAttribute('aria-expanded') !== 'true') await readout.click();
    await approve.click();
    await expect(terminal.page.locator('#flow-strip')).toContainText('verify');
    await expect.poll(async () => {
      const { texts, kinds } = await read();
      const newest = texts.slice(0, 2).findIndex((text, index) => !kinds[index] && /verify/i.test(text));
      return newest >= 0;
    }, { timeout: 60_000 }).toBe(true);
  } finally {
    try { await h.dispose(); }
    finally { gate?.dispose(); }
  }
});
