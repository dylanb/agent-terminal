/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readActiveFlow } from '../../src/main/activeFlowPointer';
import { createFlowPickerHarness, type FlowPickerHarness } from './flowPickerHarness';

// A3 (#134) §18.7.4 / §18.7.6 — the flow picker in the strip region, driven through the real app.

let h: FlowPickerHarness | undefined;
test.afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const pickerHost = (page: Page): Locator => page.locator('#app .rail:has(#flow-strip) #flow-picker');
const pickerTrigger = (page: Page): Locator => pickerHost(page).getByRole('button', { name: /flow/i });
const pickerOption = (page: Page, id: string): Locator => pickerHost(page).getByRole('option', { name: new RegExp(id) });

async function openPicker(page: Page): Promise<void> {
  await expect(pickerTrigger(page)).toBeEnabled({ timeout: 10_000 });
  await pickerTrigger(page).click();
  await expect(pickerHost(page).getByRole('listbox')).toBeVisible();
}

test('AC1: picking the second of two global catalog flows shows its steps, and the choice survives a relaunch', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  harness.seedGlobalEntry('picker-flow-one', ['one-first', 'one-second']);
  harness.seedGlobalEntry('picker-flow-two', ['two-first', 'two-second']);
  harness.seedGlobalFallback(['fallback-first']);
  const repo = harness.repo('agent-term-e2e-a3-ac1-');

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('fallback-first', { timeout: 10_000 });
  await openPicker(page);
  await pickerOption(page, 'picker-flow-two').click();

  await expect(harness.stepName(1)).toHaveText('two-first', { timeout: 10_000 });
  await expect(harness.stepName(2)).toHaveText('two-second');
  expect(readActiveFlow(repo)).toEqual({ kind: 'value', id: 'picker-flow-two' });

  const relaunched = await harness.relaunch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('two-first', { timeout: 10_000 });
  await expect(harness.stepName(2)).toHaveText('two-second');
  await openPicker(relaunched);
  await expect(pickerOption(relaunched, 'picker-flow-two')).toHaveAttribute('aria-selected', 'true');
  await expect(pickerOption(relaunched, 'picker-flow-one')).not.toHaveAttribute('aria-selected', 'true');
});

test("AC2: each worktree's picker lists its own repo-tier entries plus the shared global ones, never the other repo's", { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  harness.seedGlobalEntry('shared-global-flow', ['shared-first']);
  const repoA = harness.repo('agent-term-e2e-a3-ac2-a-');
  const repoB = harness.repo('agent-term-e2e-a3-ac2-b-');
  harness.seedRepoEntry(repoA, 'repo-a-only-flow', ['a-only-first']);
  harness.seedRepoEntry(repoB, 'repo-b-only-flow', ['b-only-first']);
  harness.selectFlow(repoA, 'repo-a-only-flow');
  harness.selectFlow(repoB, 'repo-b-only-flow');

  const page = await harness.launch();

  await harness.cdInto(repoA);
  await expect(harness.stepName(1)).toHaveText('a-only-first', { timeout: 10_000 });
  await openPicker(page);
  await expect(pickerOption(page, 'repo-a-only-flow')).toBeVisible();
  await expect(pickerOption(page, 'shared-global-flow')).toBeVisible();
  await expect(pickerHost(page).getByRole('option')).toHaveCount(2);
  await expect(pickerOption(page, 'repo-b-only-flow')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await harness.cdInto(repoB);
  await expect(harness.stepName(1)).toHaveText('b-only-first', { timeout: 10_000 });
  await openPicker(page);
  await expect(pickerOption(page, 'repo-b-only-flow')).toBeVisible();
  await expect(pickerOption(page, 'shared-global-flow')).toBeVisible();
  await expect(pickerHost(page).getByRole('option')).toHaveCount(2);
  await expect(pickerOption(page, 'repo-a-only-flow')).toHaveCount(0);

  const ids = async (rk: string): Promise<string[]> =>
    page.evaluate(async (key) => {
      const r = await window.flow.listCatalog(key);
      return r.ok ? r.listing.entries.map((e) => (e.available ? e.id : e.label)) : [];
    }, rk);
  const listedA = await ids(repoA);
  expect(listedA).toContain('repo-a-only-flow');
  expect(listedA).not.toContain('repo-b-only-flow');
});

test('flow:listCatalog lists a worktree the app entered and refuses one it never entered, with a reason (§6 resource identity)', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  harness.seedGlobalEntry('unregistered-probe-flow', ['probe-first']);
  const entered = harness.repo('agent-term-e2e-a3-listed-');
  const never = harness.repo('agent-term-e2e-a3-unregistered-');

  const page = await harness.launch();
  await harness.cdInto(entered);

  const listFor = (rk: string): Promise<unknown> => page.evaluate((key) => window.flow.listCatalog(key), rk);

  const listed = await listFor(entered);
  expect(listed).toMatchObject({
    ok: true,
    listing: { entries: expect.arrayContaining([expect.objectContaining({ id: 'unregistered-probe-flow' })]) },
  });
  expect(await listFor(never)).toMatchObject({ ok: false, reason: expect.stringMatching(/\S/) });
  expect(await listFor('relative/path')).toMatchObject({ ok: false, reason: expect.stringMatching(/\S/) });
});
