/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readActiveFlow } from '../../src/main/activeFlowPointer';
import { createFlowPickerHarness, type FlowPickerHarness } from './flowPickerHarness';
import { shellQuote } from '../../src/shared/shellQuote';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { flowCatalogDir, flowHomeDir, FLOW_DEF_FILE } from '../../src/main/flow';

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

test('a worktree change while the picker holds keyboard focus lands focus in the app, never on <body> (WCAG 2.4.3)', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  harness.seedGlobalEntry('shared-global-flow', ['shared-first']);
  const repoA = harness.repo('agent-term-e2e-a3-focus-a-');
  const repoB = harness.repo('agent-term-e2e-a3-focus-b-');
  harness.seedRepoEntry(repoA, 'repo-a-only-flow', ['a-only-first']);
  harness.seedRepoEntry(repoB, 'repo-b-only-flow', ['b-only-first']);
  harness.selectFlow(repoA, 'repo-a-only-flow');
  harness.selectFlow(repoB, 'repo-b-only-flow');

  const page = await harness.launch();
  await harness.cdInto(repoA);
  await expect(harness.stepName(1)).toHaveText('a-only-first', { timeout: 10_000 });
  await expect(pickerTrigger(page)).toBeEnabled({ timeout: 10_000 });

  await page.locator('.xterm-screen').click();
  await page.keyboard.type(`sleep 2 && cd ${shellQuote(repoB)}`, { delay: 20 });
  await page.keyboard.press('Enter');
  await pickerTrigger(page).focus();
  await expect(pickerTrigger(page)).toBeFocused();
  await expect(harness.stepName(1)).toHaveText('a-only-first');

  await expect(harness.stepName(1)).toHaveText('b-only-first', { timeout: 10_000 });
  expect(await page.evaluate(() => document.activeElement === null || document.activeElement === document.body)).toBe(false);
});

const flowControl = (page: Page): Locator => page.locator('#flow-strip .flow-control');
const flowError = (page: Page): Locator => page.locator('#flow-strip .flow-error');
const flowTerminate = (page: Page): Locator => page.locator('#flow-strip .flow-terminate');
const confirmModal = (page: Page): Locator => page.locator('#flow-confirm-host .flow-modal');
const inputModal = (page: Page): Locator => page.locator('#flow-modal-host .flow-modal');
const useDefault = (page: Page): Locator => pickerHost(page).getByText(/use the default/i);

/** A catalog entry whose first step is a §27 loop step declaring one required input, so a Start prompts for it. */
function seedLoopEntry(root: string, id: string, stepId: string, input: string): void {
  const entry = join(flowCatalogDir(root), id);
  mkdirSync(entry, { recursive: true });
  writeFileSync(
    join(entry, FLOW_DEF_FILE),
    `name: ${id}\nsteps:\n  - id: ${stepId}\n    kind: loop\n    loop: impl-loop\n    loop_namespace: app\n` +
      `    inputs:\n      - name: ${input}\n        type: github-ticket\n        required: true\n`,
  );
}

test('AC3: with no flow to run, the picker is usable from the error view, and a pick shows that flow at Not started with Start', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  harness.seedGlobalEntry('rescue-flow', ['rescue-first', 'rescue-second']);
  const repo = harness.repo('agent-term-e2e-a3-ac3-');

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(flowError(page)).toBeVisible({ timeout: 10_000 });

  await openPicker(page);
  await pickerOption(page, 'rescue-flow').click();

  await expect(harness.stepName(1)).toHaveText('rescue-first', { timeout: 10_000 });
  await expect(flowControl(page)).toHaveText('Start');
  await expect(flowError(page)).toHaveCount(0);
  expect(readActiveFlow(repo)).toEqual({ kind: 'value', id: 'rescue-flow' });
});

test('AC4: "use the default" clears the selection to the unset resolution, and opening then dismissing writes nothing across a relaunch', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  harness.seedGlobalEntry('chosen-flow', ['chosen-first']);
  harness.seedGlobalFallback(['fallback-first']);
  const repo = harness.repo('agent-term-e2e-a3-ac4-');
  harness.selectFlow(repo, 'chosen-flow');

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('chosen-first', { timeout: 10_000 });

  await openPicker(page);
  await expect(useDefault(page)).toBeVisible();
  await useDefault(page).click();
  await expect(harness.stepName(1)).toHaveText('fallback-first', { timeout: 10_000 });
  expect(readActiveFlow(repo)).toEqual({ kind: 'unset' });

  await openPicker(page);
  await page.keyboard.press('Escape');
  await expect(pickerHost(page).getByRole('listbox')).toHaveCount(0);

  const relaunched = await harness.relaunch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('fallback-first', { timeout: 10_000 });
  expect(readActiveFlow(repo)).toEqual({ kind: 'unset' });
  await openPicker(relaunched);
  await expect(pickerOption(relaunched, 'chosen-flow')).toBeVisible();
  await expect(pickerOption(relaunched, 'chosen-flow')).not.toHaveAttribute('aria-selected', 'true');
});

test("AC6/AC7/AC5: a started run locks the picker; after Terminate it is usable with the pre-run pick highlighted, and a switched flow's step 0 asks for its own input", { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  harness.seedGlobalEntry('flow-a', ['a-first', 'a-second']);
  seedLoopEntry(harness.home, 'flow-b', 'b-first', 'pr');
  const repo = harness.repo('agent-term-e2e-a3-ac7-');
  harness.selectFlow(repo, 'flow-a');

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('a-first', { timeout: 10_000 });
  await expect(pickerTrigger(page)).toBeEnabled({ timeout: 10_000 });

  await flowControl(page).click();
  await expect(flowControl(page)).toHaveText('Advance', { timeout: 10_000 });
  await expect(pickerTrigger(page)).toBeDisabled({ timeout: 10_000 });

  await flowTerminate(page).click();
  await expect(confirmModal(page)).toBeVisible();
  await confirmModal(page).locator('.confirm').click();
  await expect(flowControl(page)).toHaveText('Start', { timeout: 10_000 });

  await openPicker(page);
  await expect(pickerOption(page, 'flow-a')).toHaveAttribute('aria-selected', 'true');
  await pickerOption(page, 'flow-b').click();
  await expect(harness.stepName(1)).toHaveText('b-first', { timeout: 10_000 });

  await flowControl(page).click();
  await expect(inputModal(page)).toBeVisible({ timeout: 10_000 });
  await expect(inputModal(page).locator('.field .nm')).toHaveText(['pr']);
});

test('AC6: a corrupt progression renders the picker locked with its reason, and no picker control is enabled', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  harness.seedGlobalEntry('corrupt-probe-flow', ['probe-first']);
  harness.seedGlobalFallback(['fallback-first']);
  const repo = harness.repo('agent-term-e2e-a3-ac6-corrupt-');
  mkdirSync(flowHomeDir(repo), { recursive: true });
  writeFileSync(join(flowHomeDir(repo), 'flow-state.yaml'), '[unterminated flow sequence');

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(flowError(page)).toBeVisible({ timeout: 10_000 });
  await expect(pickerTrigger(page)).toBeVisible({ timeout: 10_000 });

  await expect(pickerHost(page)).toContainText(/terminate/i, { timeout: 10_000 });
  const controls = pickerHost(page).getByRole('button');
  const count = await controls.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) await expect(controls.nth(i)).toBeDisabled();
  await expect(pickerHost(page).getByRole('option')).toHaveCount(0);
});
