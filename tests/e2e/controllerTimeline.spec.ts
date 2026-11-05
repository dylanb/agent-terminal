import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { heldHumanGate, type HeldHumanGate } from './autoGateHarness';
import { cardHeaderLocator, cardLocator, historyLocator, timelineEntriesLocator } from '../helpers/controllerCards';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };

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
    await gate.release();
    const source = await terminal.page.evaluate(directory => window.flow.state(directory), repo);
    expect(source.loop?.humanNeeded).toBe(true);
    await expect.poll(async () => {
      const { texts, kinds } = await read();
      const request = texts.findIndex((text, index) => kinds[index] && text.includes(source.loop!.status));
      return request >= 0 && request + 1 < texts.length && !kinds[request + 1] && /idle/i.test(texts[request + 1]);
    }, { timeout: 60_000 }).toBe(true);
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
