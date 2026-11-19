/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';
import { activeFlowPointerFile, readActiveFlow } from '../../src/main/activeFlowPointer';
import { catalogRefusalReason } from '../../src/main/resolveRunDefinition';
import { createCatalogFixture } from '../helpers/catalogFixture';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { createFlowPickerHarness, type FlowPickerHarness } from './flowPickerHarness';
import { shellQuote } from '../../src/shared/shellQuote';
import { MAX_CATALOG_ID_LENGTH } from '../../src/shared/pathSegment';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readRunBinding, runDispositionFile } from '../../src/main/runDisposition';
import { join } from 'node:path';
import { flowCatalogDir, flowHomeDir, FLOW_DEF_FILE } from '../../src/main/flow';
import type { RebindChoice } from '../../src/shared/ipc';
import { auditRepoDir, auditRootDir } from '../../src/main/auditPaths';
import { parseAuditStream } from '../../src/shared/audit';

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
  await expect(harness.stepName(1)).toHaveText('Fallback first', { timeout: 10_000 });
  await openPicker(page);
  await pickerOption(page, 'picker-flow-two').click();

  await expect(harness.stepName(1)).toHaveText('Two first', { timeout: 10_000 });
  await expect(harness.stepName(2)).toHaveText('Two second');
  expect(readActiveFlow(repo)).toEqual({ kind: 'value', id: 'picker-flow-two' });

  const relaunched = await harness.relaunch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('Two first', { timeout: 10_000 });
  await expect(harness.stepName(2)).toHaveText('Two second');
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
  await expect(harness.stepName(1)).toHaveText('A only first', { timeout: 10_000 });
  await openPicker(page);
  await expect(pickerOption(page, 'repo-a-only-flow')).toBeVisible();
  await expect(pickerOption(page, 'shared-global-flow')).toBeVisible();
  await expect(pickerHost(page).getByRole('option')).toHaveCount(2);
  await expect(pickerOption(page, 'repo-b-only-flow')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await harness.cdInto(repoB);
  await expect(harness.stepName(1)).toHaveText('B only first', { timeout: 10_000 });
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
  await expect(harness.stepName(1)).toHaveText('A only first', { timeout: 10_000 });
  await expect(pickerTrigger(page)).toBeEnabled({ timeout: 10_000 });

  await page.locator('.xterm-screen').click();
  await page.keyboard.type(`sleep 2 && cd ${shellQuote(repoB)}`, { delay: 20 });
  await page.keyboard.press('Enter');
  await pickerTrigger(page).focus();
  await expect(pickerTrigger(page)).toBeFocused();
  await expect(harness.stepName(1)).toHaveText('A only first');

  await expect(harness.stepName(1)).toHaveText('B only first', { timeout: 10_000 });
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
    `name: ${id}\nsteps:\n  - id: ${stepId}\n    kind: loop\n    loop: infra-loop\n    loop_namespace: app\n` +
      `    inputs:\n      - name: ${input}\n        type: github-ticket\n        required: true\n`,
  );
}

// Its first step picks up a ticket through the shipped infra-loop, which has no pickup: entering it fails and rolls back.
function seedFailingPickupEntry(root: string, id: string, stepId: string): void {
  const entry = join(flowCatalogDir(root), id);
  mkdirSync(entry, { recursive: true });
  writeFileSync(
    join(entry, FLOW_DEF_FILE),
    `name: ${id}\nsteps:\n  - id: ${stepId}\n    kind: loop\n    loop: infra-loop\n    loop_namespace: app\n    bootstrap: pickup\n` +
      `  - id: ${stepId}-next\n    kind: manual\n`,
  );
}

test('a first-step bootstrap failure leaves no run record: the picker unlocks with no Terminate, and a new Start runs (§18.7.4)', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  seedFailingPickupEntry(harness.home, 'pickup-flow', 'p-first');
  harness.seedGlobalEntry('other-flow', ['o-first', 'o-second']);
  const repo = harness.repo('agent-term-e2e-a3-first-rollback-');
  harness.selectFlow(repo, 'pickup-flow');

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('P first', { timeout: 10_000 });
  await flowControl(page).click();

  const bootstrapError = page.locator('#flow-error-host .flow-modal');
  await expect(bootstrapError).toContainText('no pickup to run', { timeout: 15_000 });
  await bootstrapError.locator('.dismiss').click();
  await expect(flowControl(page)).toHaveText('Start', { timeout: 10_000 });

  await expect.poll(() => existsSync(runDispositionFile(repo)), { timeout: 10_000 }).toBe(false);
  await expect(pickerHost(page)).not.toContainText('Locked until you Terminate the run');
  await expect(flowTerminate(page)).toHaveCount(0);
  await openPicker(page);
  await pickerOption(page, 'other-flow').click();
  await expect(harness.stepName(1)).toHaveText('O first', { timeout: 10_000 });
  await flowControl(page).click();
  await expect(flowControl(page)).toHaveText('Advance', { timeout: 10_000 });
});

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

  await expect(harness.stepName(1)).toHaveText('Rescue first', { timeout: 10_000 });
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
  await expect(harness.stepName(1)).toHaveText('Chosen first', { timeout: 10_000 });

  await openPicker(page);
  await expect(useDefault(page)).toBeVisible();
  await useDefault(page).click();
  await expect(harness.stepName(1)).toHaveText('Fallback first', { timeout: 10_000 });
  expect(readActiveFlow(repo)).toEqual({ kind: 'unset' });

  await openPicker(page);
  await page.keyboard.press('Escape');
  await expect(pickerHost(page).getByRole('listbox')).toHaveCount(0);

  const relaunched = await harness.relaunch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('Fallback first', { timeout: 10_000 });
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
  await expect(harness.stepName(1)).toHaveText('A first', { timeout: 10_000 });
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
  await expect(harness.stepName(1)).toHaveText('B first', { timeout: 10_000 });

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

const stationState = (page: Page, i: number): Locator => page.locator('#flow-strip .flow.vert .stn').nth(i);
const pickerAlert = (page: Page): Locator => pickerHost(page).getByRole('alert');
const UNREADABLE_TIER = /could not (be )?read|unreadable|not a directory|ENOTDIR/i;

/** How many elements in the picker, outside every option row, show text matching both `text` and `tier`. */
const tierNotices = (page: Page, text: RegExp, tier: RegExp): Promise<number> =>
  pickerHost(page).evaluate(
    (host, [t, o]) =>
      [...host.querySelectorAll('*')].filter((el) => {
        const shown = el.textContent ?? '';
        return new RegExp(t, 'i').test(shown) && new RegExp(o, 'i').test(shown)
          && el.querySelector('[role="option"]') === null && el.closest('[role="option"]') === null;
      }).length,
    [text.source, tier.source] as const,
  );

test('AC8: a repo entry whose flow.yaml escapes its tier is listed, cannot be picked, and shows why', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const cat = createCatalogFixture();
  try {
    harness.seedGlobalEntry('escaping-flow', ['global-first']);
    harness.seedGlobalFallback(['fallback-first']);
    const repo = harness.repo('agent-term-e2e-a3-ac8-');
    harness.seedRepoEntry(repo, 'escaping-flow', ['repo-first']);
    cat.symlinkEntryFlowYaml(flowCatalogDir(repo), 'escaping-flow');

    const page = await harness.launch();
    await harness.cdInto(repo);
    await expect(harness.stepName(1)).toHaveText('Fallback first', { timeout: 10_000 });
    await openPicker(page);
    const row = pickerOption(page, 'escaping-flow');
    await expect(row).toHaveCount(1);
    await expect(row).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(catalogRefusalReason('escapes'));
    await row.click({ force: true });
    const afterClick = await page.evaluate((key) => window.flow.listCatalog(key), repo);
    expect(afterClick.ok && afterClick.listing.selection, 'no pointer write follows the click').toEqual({ kind: 'unset' });
    await expect(row).not.toHaveAttribute('aria-selected', 'true');
    await expect(pickerTrigger(page)).toHaveText('Flow: default');
    await expect(harness.stepName(1)).toHaveText('Fallback first');
    expect(readActiveFlow(repo)).toEqual({ kind: 'unset' });
  } finally {
    cat.cleanup();
  }
});

test('AC9: an unreadable repo tier shows a repo-tier notice beside the global entries, listed unavailable with the repo-tier reason', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const cat = createCatalogFixture();
  try {
    harness.seedGlobalEntry('global-only-flow', ['global-first']);
    harness.seedGlobalFallback(['fallback-first']);
    const repo = harness.repo('agent-term-e2e-a3-ac9-');
    cat.makeUnreadableTier(repo);

    const page = await harness.launch();
    await harness.cdInto(repo);
    await expect(pickerTrigger(page), 'the listing survives an unreadable repo tier').toHaveText('Flow: default', { timeout: 10_000 });
    await openPicker(page);
    const row = pickerOption(page, 'global-only-flow');
    await expect(row).toHaveCount(1);
    await expect.poll(() => tierNotices(page, UNREADABLE_TIER, /\brepo\b/), { message: 'a repo-tier notice outside the rows' }).toBeGreaterThan(0);
    await expect(row).toHaveAttribute('aria-disabled', 'true');
    await expect(row).toContainText(catalogRefusalReason('unresolvable'));
  } finally {
    cat.cleanup();
  }
});

test('AC10: an over-long hostile pointer with a local flow.yaml shows a clean, bounded flow-load error, and the picker still picks', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const fx = createWorktreeFixture();
  try {
    harness.seedGlobalEntry('valid-flow', ['valid-first', 'valid-second']);
    harness.seedGlobalFallback(['fallback-first']);
    const repo = harness.repo('agent-term-e2e-a3-ac10-');
    harness.seedLocalFlow(repo, ['local-first']);
    fx.writePointer(repo, `"zz\\u202Ebidi\\u200Bzwsp\\abell${'z'.repeat(120)}"\n`);

    const page = await harness.launch();
    await harness.cdInto(repo);
    await expect(flowError(page)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#flow-strip .flow.vert')).toHaveCount(0);
    const text = (await flowError(page).textContent()) ?? '';
    expect(text).toMatch(/\S/);
    expect(text).not.toMatch(/[\u202E\u200B\u0000-\u001F]/u);
    expect(text, 'the rejected name is shown').toMatch(/z{8,}/);
    expect(text, 'the rejected name is truncated').not.toContain('z'.repeat(MAX_CATALOG_ID_LENGTH + 1));
    await expect(page.locator('#flow-strip')).not.toContainText('local-first');
    await expect(page.locator('#flow-strip')).not.toContainText('fallback-first');

    await openPicker(page);
    await pickerOption(page, 'valid-flow').click();
    await expect(harness.stepName(1)).toHaveText('Valid first', { timeout: 10_000 });
    await expect(flowControl(page)).toHaveText('Start');
    await expect(flowError(page)).toHaveCount(0);
  } finally {
    fx.cleanup();
  }
});

test('AC11: a pick whose pointer write fails shows the reason and returns the highlight to the prior pick', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const fx = createWorktreeFixture();
  try {
    harness.seedGlobalEntry('flow-a', ['a-first']);
    harness.seedGlobalEntry('flow-b', ['b-first']);
    const repo = harness.repo('agent-term-e2e-a3-ac11-');
    harness.selectFlow(repo, 'flow-a');

    const page = await harness.launch();
    await harness.cdInto(repo);
    await expect(harness.stepName(1)).toHaveText('A first', { timeout: 10_000 });
    await openPicker(page);
    await expect(pickerOption(page, 'flow-a')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');

    fx.plantPointerDirectory(repo);
    await openPicker(page);
    await pickerOption(page, 'flow-b').click();

    await expect(pickerAlert(page)).toHaveText(/\S/, { timeout: 10_000 });
    await expect(page.locator('#flow-strip'), 'the refused pick is not rendered').not.toContainText('b-first');
    expect(readActiveFlow(repo)).not.toEqual({ kind: 'value', id: 'flow-b' });
    await openPicker(page);
    await expect(pickerOption(page, 'flow-a')).toHaveAttribute('aria-selected', 'true');
    await expect(pickerOption(page, 'flow-b')).not.toHaveAttribute('aria-selected', 'true');
  } finally {
    fx.cleanup();
  }
});

test("AC18: the operator's pick wins over a local flow.yaml at Start and after a relaunch, and an empty repo tier shows no notice", { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  harness.seedGlobalEntry('pick-one', ['one-first', 'one-second']);
  harness.seedGlobalEntry('pick-two', ['two-first', 'two-second']);
  const repo = harness.repo('agent-term-e2e-a3-ac18-');
  harness.seedLocalFlow(repo, ['local-first', 'local-second']);
  mkdirSync(flowCatalogDir(repo), { recursive: true });

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('Local first', { timeout: 10_000 });
  await openPicker(page);
  await expect(pickerOption(page, 'pick-two')).toHaveCount(1);
  expect(await tierNotices(page, /\S/, /\b(repo|global)\b/), 'an empty repo tier shows no tier notice').toBe(0);
  await pickerOption(page, 'pick-two').click();
  await expect(harness.stepName(1)).toHaveText('Two first', { timeout: 10_000 });
  await expect(harness.stepName(2)).toHaveText('Two second');

  await flowControl(page).click();
  await expect(flowControl(page)).toHaveText('Advance', { timeout: 10_000 });
  await expect(stationState(page, 1)).toHaveClass(/\bactive\b/);
  await expect(harness.stepName(1)).toHaveText('Two first');

  await harness.relaunch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('Two first', { timeout: 10_000 });
  await expect(stationState(harness.page(), 1)).toHaveClass(/\bactive\b/);
  await expect(flowControl(harness.page())).toHaveText('Advance');
  await expect(pickerTrigger(harness.page())).toHaveText('Flow: pick-two', { timeout: 10_000 });
  expect(readActiveFlow(repo)).toEqual({ kind: 'value', id: 'pick-two' });
});

test('AC18: a non-file at the pointer path shows the flow-load error, and "use the default" clears it to the local flow at Not started', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const fx = createWorktreeFixture();
  try {
    harness.seedGlobalEntry('some-flow', ['some-first']);
    const repo = harness.repo('agent-term-e2e-a3-ac18-nonfile-');
    harness.seedLocalFlow(repo, ['local-first', 'local-second']);
    fx.plantPointerDirectory(repo);

    const page = await harness.launch();
    await harness.cdInto(repo);
    await expect(flowError(page)).toBeVisible({ timeout: 10_000 });
    await expect(pickerTrigger(page)).toHaveText('Flow: selection unusable', { timeout: 10_000 });

    await openPicker(page);
    await useDefault(page).click();
    await expect(harness.stepName(1)).toHaveText('Local first', { timeout: 10_000 });
    await expect(flowControl(page)).toHaveText('Start');
    await expect(flowError(page)).toHaveCount(0);
    expect(existsSync(activeFlowPointerFile(repo))).toBe(false);
  } finally {
    fx.cleanup();
  }
});

const recoverControl = (page: Page): Locator => pickerHost(page).getByRole('button', { name: /recover/i });
const flowStation = (page: Page, i: number): Locator => page.locator('#flow-strip .flow.vert .stn').nth(i);

/** Every picker button other than the recovery control is disabled: a held run's selection changes only through
 *  recovery (AC6). */
async function expectOnlyRecoveryEnabled(page: Page): Promise<void> {
  const buttons = pickerHost(page).getByRole('button');
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const b = buttons.nth(i);
    const name = `${(await b.textContent()) ?? ''} ${(await b.getAttribute('aria-label')) ?? ''}`;
    if (!/recover/i.test(name)) await expect(b).toBeDisabled();
  }
}

/** The three run files a rebind may touch, as bytes (null when absent), so "nothing changed" is a byte compare. */
function runFiles(repo: string): (string | null)[] {
  return [join(flowHomeDir(repo), 'flow-state.yaml'), runDispositionFile(repo), activeFlowPointerFile(repo)].map((f) =>
    existsSync(f) ? readFileSync(f).toString('base64') : null,
  );
}

/** A repo whose run began at step `s2` and whose run record is then missing: a held run. */
function seedHeldRepo(harness: FlowPickerHarness, prefix: string): string {
  harness.seedGlobalEntry('resume-flow', ['s1', 's2', 's3']);
  harness.seedGlobalEntry('no-s2-flow', ['x1', 'x2']);
  harness.seedGlobalFallback(['s1', 's2']);
  const repo = harness.repo(prefix);
  harness.seedRepoEntry(repo, 'alpha-flow', ['s1', 's2']);
  harness.seedLocalFlow(repo, ['s1', 's2']);
  const wt = createWorktreeFixture();
  wt.writeFlowState(repo, { step: 's2', status: 'in_progress' });
  wt.removeRunRecord(repo);
  return repo;
}

test('AC14/AC16: a held run with a missing record offers recovery naming the step and every origin, and dismissing it changes nothing', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const repo = seedHeldRepo(harness, 'agent-term-e2e-a3-held-missing-');
  const before = runFiles(repo);

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(flowError(page)).toBeVisible({ timeout: 10_000 });
  await expect(flowTerminate(page)).toBeVisible();

  await expect(recoverControl(page)).toBeEnabled({ timeout: 10_000 });
  await expectOnlyRecoveryEnabled(page);
  await recoverControl(page).click();
  await expect(pickerHost(page)).toContainText(/missing/i);
  await expect(pickerHost(page)).not.toContainText(/unreadable/i);
  await expect(pickerHost(page)).toContainText('s2');
  await expect(pickerHost(page)).toContainText(/in progress/i);
  const rows = pickerHost(page).getByRole('option');
  await expect(rows.filter({ hasText: /local|this worktree/i })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'alpha-flow' })).toContainText(/repo/i);
  await expect(rows.filter({ hasText: 'alpha-flow' })).not.toContainText(/global/i);
  await expect(rows.filter({ hasText: 'resume-flow' })).toContainText(/global/i);
  await expect(rows.filter({ hasText: /fallback/i })).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(pickerHost(page).getByRole('option')).toHaveCount(0);
  await expect(flowError(page)).toBeVisible();
  await expect(flowTerminate(page)).toBeVisible();
  await expect(recoverControl(page)).toBeEnabled();
  expect(runFiles(repo)).toEqual(before);
});

test('AC14: a held run with a garbage record says the record is unreadable', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const repo = seedHeldRepo(harness, 'agent-term-e2e-a3-held-garbage-');
  createWorktreeFixture().writeRunRecordRaw(repo, '[unterminated flow sequence');

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(flowError(page)).toBeVisible({ timeout: 10_000 });
  await expect(recoverControl(page)).toBeEnabled({ timeout: 10_000 });
  await recoverControl(page).click();
  await expect(pickerHost(page)).toContainText(/unreadable/i);
  await expect(pickerHost(page)).not.toContainText(/missing/i);
});

test('AC17: a corrupt progression offers Terminate but no recovery, and the picker stays locked', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  harness.seedGlobalEntry('corrupt-held-flow', ['s1', 's2']);
  const repo = harness.repo('agent-term-e2e-a3-held-corrupt-');
  const wt = createWorktreeFixture();
  wt.writeFlowStateRaw(repo, '[unterminated flow sequence');
  wt.removeRunRecord(repo);

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(flowError(page)).toBeVisible({ timeout: 10_000 });
  await expect(flowTerminate(page)).toBeVisible();
  await expect(pickerTrigger(page)).toBeDisabled({ timeout: 10_000 });
  await expect(recoverControl(page)).toHaveCount(0);
});

test('AC17: flow:rebindHeldRun reaches recovery for an entered held worktree, and is refused before it for one the app never entered or a malformed choice, changing nothing (§6 resource identity)', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const never = seedHeldRepo(harness, 'agent-term-e2e-a3-rebind-unregistered-');
  const entered = harness.repo('agent-term-e2e-a3-rebind-entered-');
  const enteredRun = createWorktreeFixture();
  enteredRun.writeFlowState(entered, { step: 's2', status: 'in_progress' });
  enteredRun.removeRunRecord(entered);
  const before = runFiles(never);
  const enteredBefore = runFiles(entered);

  const page = await harness.launch();
  await harness.cdInto(entered);

  const rebind = (rk: string, choice: unknown = { origin: 'global', id: 'resume-flow' }): Promise<unknown> =>
    page.evaluate(([key, c]) => window.flow.rebindHeldRun(key, c as RebindChoice, 'refuse'), [rk, choice] as const);
  const refused = { ok: false, reason: expect.stringMatching(/\S/) };

  expect(await rebind('relative/path')).toMatchObject(refused);
  expect(await rebind(entered, { origin: 'global', id: '../escape' })).toMatchObject(refused);
  expect(runFiles(entered)).toEqual(enteredBefore);
  expect(await rebind(never)).toMatchObject(refused);
  expect(runFiles(never)).toEqual(before);

  expect(await rebind(entered)).toEqual({ ok: true, outcome: 'resumed' });
  const [progression, , pointer] = runFiles(entered);
  expect([progression, pointer]).toEqual([enteredBefore[0], enteredBefore[2]]);
  expect(readRunBinding(entered)).toEqual({ source: 'catalog', tier: 'global', id: 'resume-flow' });
});

/** A repo whose run began at step `s2`, with no local flow.yaml, whose run record is then damaged by `damage`. */
function seedHeldRunWithoutLocal(harness: FlowPickerHarness, prefix: string, damage: (repo: string) => void): string {
  harness.seedGlobalEntry('resume-flow', ['s1', 's2', 's3']);
  harness.seedGlobalEntry('other-flow', ['o1', 'o2']);
  harness.seedGlobalFallback(['s1', 's2', 'fallback-3']);
  const repo = harness.repo(prefix);
  createWorktreeFixture().writeFlowState(repo, { step: 's2', status: 'in_progress' });
  damage(repo);
  return repo;
}

async function recoverOnto(page: Page, row: RegExp | string): Promise<void> {
  await expect(recoverControl(page)).toBeEnabled({ timeout: 10_000 });
  await recoverControl(page).click();
  await pickerHost(page).getByRole('option').filter({ hasText: row }).click();
}

test('AC12/AC15: a held run with a missing record resumes onto a catalog flow at its step, and stays on it across a relaunch despite a changed pointer and an added local flow.yaml', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const repo = seedHeldRunWithoutLocal(harness, 'agent-term-e2e-a3-resume-catalog-', (r) => createWorktreeFixture().removeRunRecord(r));
  const [progressionBefore] = runFiles(repo);

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(flowError(page)).toBeVisible({ timeout: 10_000 });
  await recoverOnto(page, 'resume-flow');

  await expect(harness.stepName(3)).toHaveText('S3', { timeout: 10_000 });
  await expect(harness.stepName(2)).toHaveText('S2');
  await expect(flowStation(page, 2)).toHaveClass(/\bactive\b/);
  await expect(flowError(page)).toHaveCount(0);
  expect(runFiles(repo)[0]).toEqual(progressionBefore);
  expect(existsSync(activeFlowPointerFile(repo))).toBe(false);

  await harness.close();
  harness.selectFlow(repo, 'other-flow');
  harness.seedLocalFlow(repo, ['s1', 's2']);
  const relaunched = await harness.relaunch();
  await harness.cdInto(repo);
  await expect(harness.stepName(3)).toHaveText('S3', { timeout: 10_000 });
  await expect(flowStation(relaunched, 2)).toHaveClass(/\bactive\b/);
});

test('AC13/AC15: a held run with a garbage record resumes onto the global fallback, and stays on it across a relaunch despite a changed pointer and an added local flow.yaml', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const repo = seedHeldRunWithoutLocal(harness, 'agent-term-e2e-a3-resume-fallback-', (r) =>
    createWorktreeFixture().writeRunRecordRaw(r, '[unterminated flow sequence'),
  );

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(flowError(page)).toBeVisible({ timeout: 10_000 });
  await recoverOnto(page, /fallback/i);

  await expect(harness.stepName(3)).toHaveText('Fallback 3', { timeout: 10_000 });
  await expect(flowStation(page, 2)).toHaveClass(/\bactive\b/);
  await expect(flowError(page)).toHaveCount(0);
  expect(readRunBinding(repo)).toEqual({ source: 'fallback' });

  await harness.close();
  harness.selectFlow(repo, 'resume-flow');
  harness.seedLocalFlow(repo, ['s1', 's2']);
  const relaunched = await harness.relaunch();
  await harness.cdInto(repo);
  await expect(harness.stepName(3)).toHaveText('Fallback 3', { timeout: 10_000 });
  await expect(flowStation(relaunched, 2)).toHaveClass(/\bactive\b/);
});

/** The event types of every §25 audit run the app opened for `repo` under the harness home, found through the
 *  recorder's own path resolvers. */
function auditRuns(home: string, repo: string): string[][] {
  const dir = auditRepoDir(auditRootDir(home), repo);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => parseAuditStream(readFileSync(join(dir, f), 'utf8')).events.map((e) => e.type));
}

test('AC19/AC20: each recovery row says whether it resumes or ends the run, and choosing one that ends it asks first; cancelling leaves the run held and unchanged', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const repo = seedHeldRepo(harness, 'agent-term-e2e-a3-confirm-end-');
  const before = runFiles(repo);

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(flowError(page)).toBeVisible({ timeout: 10_000 });
  await expect(recoverControl(page)).toBeEnabled({ timeout: 10_000 });
  await recoverControl(page).click();
  const rows = pickerHost(page).getByRole('option');
  await expect(rows.filter({ hasText: 'resume-flow' })).toContainText(/resumes the run/i);
  await expect(rows.filter({ hasText: 'no-s2-flow' })).toContainText(/ends the run/i);

  await rows.filter({ hasText: 'no-s2-flow' }).click();
  await expect(confirmModal(page)).toBeVisible();
  await confirmModal(page).locator('.cancel').click();

  await expect(confirmModal(page)).toHaveCount(0);
  await expect(flowError(page)).toBeVisible();
  await expect(recoverControl(page)).toBeEnabled();
  expect(runFiles(repo)).toEqual(before);
});

test('AC12: a held run recovered onto a catalog flow lacking its step is ended as a Terminate ends it, the flow is selected at Not started over a local flow.yaml, and it survives a relaunch', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  harness.seedGlobalEntry('first-flow', ['s1', 's2']);
  harness.seedGlobalEntry('other-flow', ['o1', 'o2']);
  const repo = harness.repo('agent-term-e2e-a3-nomatch-');
  harness.seedLocalFlow(repo, ['local-first', 'local-second']);
  harness.selectFlow(repo, 'first-flow');

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('S1', { timeout: 10_000 });
  await expect(flowControl(page)).toHaveText('Start');
  await flowControl(page).click();
  await expect(flowStation(page, 1)).toHaveClass(/\bactive\b/, { timeout: 10_000 });
  await expect.poll(() => auditRuns(harness.home, repo).length).toBe(1);

  await harness.close();
  createWorktreeFixture().removeRunRecord(repo);
  const held = await harness.relaunch();
  await harness.cdInto(repo);
  await expect(flowError(held)).toBeVisible({ timeout: 10_000 });
  await recoverOnto(held, 'other-flow');
  await expect(confirmModal(held)).toBeVisible();
  await confirmModal(held).locator('.confirm').click();

  await expect.poll(() => readActiveFlow(repo), { timeout: 10_000 }).toEqual({ kind: 'value', id: 'other-flow' });
  expect(existsSync(runDispositionFile(repo))).toBe(false);
  await expect(flowError(held)).toHaveCount(0);
  await expect(harness.stepName(1)).toHaveText('O1', { timeout: 10_000 });
  await expect(harness.stepName(2)).toHaveText('O2');
  await expect(flowControl(held)).toHaveText('Start');
  await expect(recoverControl(held)).toHaveCount(0);
  await expect(pickerTrigger(held)).toBeEnabled();
  await openPicker(held);
  await expect(pickerOption(held, 'other-flow')).toHaveAttribute('aria-selected', 'true');
  await expect(pickerOption(held, 'first-flow')).not.toHaveAttribute('aria-selected', 'true');
  await held.keyboard.press('Escape');
  const runs = auditRuns(harness.home, repo);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toContain('flow.terminated');

  const relaunched = await harness.relaunch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('O1', { timeout: 10_000 });
  await expect(flowControl(relaunched)).toHaveText('Start');
});

test('a reset run whose run record was left behind: the picker names Start as the way out, and Start removes the record and begins the run', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  harness.seedGlobalFallback(['fallback-first']);
  const repo = harness.repo('agent-term-e2e-a3-stale-record-');
  harness.seedLocalFlow(repo, ['local-first', 'local-second']);
  createWorktreeFixture().plantRunRecordDirectory(repo);

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('Local first', { timeout: 10_000 });
  await expect(pickerHost(page).locator('.flow-picker-lock')).toContainText(/Start the run/);
  await expect(flowControl(page)).toHaveText('Start');
  await flowControl(page).click();

  await expect(flowStation(page, 1)).toHaveClass(/\bactive\b/, { timeout: 10_000 });
  await expect(page.locator('#flow-strip .flow-notice')).toHaveCount(0);
  expect(readRunBinding(repo)).toEqual({ source: 'non-catalog' });
});

test('integration: a flow picked and started from the picker, then held by a lost run record, resumes through recovery, and after Terminate the picker is usable again with that pick highlighted', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  harness.seedGlobalEntry('journey-a', ['ja-first', 'ja-second']);
  harness.seedGlobalEntry('journey-b', ['jb-first', 'jb-second']);
  harness.seedGlobalFallback(['fallback-first']);
  const repo = harness.repo('agent-term-e2e-a3-journey-');

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('Fallback first', { timeout: 10_000 });
  await openPicker(page);
  await pickerOption(page, 'journey-a').click();
  await expect(harness.stepName(1)).toHaveText('Ja first', { timeout: 10_000 });
  await flowControl(page).click();
  await expect(flowControl(page)).toHaveText('Advance', { timeout: 10_000 });
  await expect(pickerTrigger(page)).toBeDisabled({ timeout: 10_000 });

  await harness.close();
  createWorktreeFixture().removeRunRecord(repo);
  const held = await harness.relaunch();
  await harness.cdInto(repo);
  await expect(flowError(held)).toBeVisible({ timeout: 10_000 });
  await recoverOnto(held, 'journey-a');

  await expect(flowError(held)).toHaveCount(0, { timeout: 10_000 });
  await expect(harness.stepName(1)).toHaveText('Ja first');
  await expect(flowStation(held, 1)).toHaveClass(/\bactive\b/);
  await expect(flowControl(held)).toHaveText('Advance');
  expect(readActiveFlow(repo)).toEqual({ kind: 'value', id: 'journey-a' });
  expect(readRunBinding(repo)).toEqual({ source: 'catalog', tier: 'global', id: 'journey-a' });

  await flowTerminate(held).click();
  await expect(confirmModal(held)).toBeVisible();
  await confirmModal(held).locator('.confirm').click();
  await expect(flowControl(held)).toHaveText('Start', { timeout: 10_000 });
  await openPicker(held);
  await expect(pickerOption(held, 'journey-a')).toHaveAttribute('aria-selected', 'true');
  await pickerOption(held, 'journey-b').click();
  await expect(harness.stepName(1)).toHaveText('Jb first', { timeout: 10_000 });
  expect(readActiveFlow(repo)).toEqual({ kind: 'value', id: 'journey-b' });
});
