/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { flowHomeDir } from '../../src/main/flow';
import { readActiveFlow } from '../../src/main/activeFlowPointer';
import { currentLockHolder, serializeLockHolder, worktreeLockFile, worktreeLockRoot } from '../../src/main/worktreeLock';
import { createFlowPickerHarness, type FlowPickerHarness } from './flowPickerHarness';
import { unidentifiedHolderRemedy } from '../helpers/lockRemedy';

// A3 (#134) T6c as narrowed at impl round 2 — only an unusable worktree lock lets Start, the pointer write or Terminate run without it; every
// Terminate takes the lock (T6b).

let h: FlowPickerHarness | undefined;
test.afterEach(async ({}, testInfo) => {
  await h?.dispose(testInfo);
  h = undefined;
});

const flowControl = (page: Page): Locator => page.locator('#flow-strip .flow-control');
const flowTerminate = (page: Page): Locator => page.locator('#flow-strip .flow-terminate');
const flowNotice = (page: Page): Locator => page.locator('#flow-strip .flow-notice');
const pickerHost = (page: Page): Locator => page.locator('#app .rail:has(#flow-strip) #flow-picker');
const pickerTrigger = (page: Page): Locator => pickerHost(page).getByRole('button', { name: /flow/i });
const pickerAlert = (page: Page): Locator => pickerHost(page).getByRole('alert');
const confirmModal = (page: Page): Locator => page.locator('#flow-confirm-host .flow-modal');

async function terminateRun(page: Page): Promise<void> {
  await flowTerminate(page).click();
  await expect(confirmModal(page)).toBeVisible();
  await confirmModal(page).locator('.confirm').click();
}

function seededRepo(harness: FlowPickerHarness, prefix: string): string {
  harness.seedGlobalEntry('lock-flow', ['lock-first', 'lock-second']);
  harness.seedGlobalFallback(['fallback-first']);
  return harness.repo(prefix);
}

test('a lockfile whose holder cannot be identified refuses the pick and Start, says to delete it and try again, and is left as found', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const repo = seededRepo(harness, 'agent-term-e2e-a3-lock-unreadable-');
  const lockFile = worktreeLockFile(worktreeLockRoot(harness.home), repo);
  mkdirSync(dirname(lockFile), { recursive: true });
  const planted = serializeLockHolder({ pid: process.pid, startTime: null });
  writeFileSync(lockFile, planted);

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('fallback-first', { timeout: 10_000 });

  const remedy = unidentifiedHolderRemedy(lockFile);
  const pointerBefore = readActiveFlow(repo);
  const write = await page.evaluate((rk) => window.flow.setActiveFlow(rk, 'lock-flow'), repo);
  expect(write.ok).toBe(false);
  if (!write.ok) {
    expect(write.reason).toContain(remedy.path);
    expect(write.reason).toMatch(remedy.deletes);
    expect(write.reason).toMatch(remedy.retries);
  }
  expect(readActiveFlow(repo)).toEqual(pointerBefore);
  await expect(pickerTrigger(page)).toBeEnabled({ timeout: 10_000 });
  await pickerTrigger(page).click();
  await pickerHost(page).getByRole('option', { name: /lock-flow/ }).click();
  await expect(pickerAlert(page)).toContainText(remedy.path, { timeout: 10_000 });
  await expect(pickerAlert(page)).toHaveText(remedy.deletes);
  await expect(pickerAlert(page)).toHaveText(remedy.retries);
  expect(readActiveFlow(repo)).toEqual(pointerBefore);
  await flowControl(page).click();
  await expect(flowNotice(page)).toContainText(remedy.path, { timeout: 10_000 });
  await expect(flowNotice(page)).toHaveText(remedy.deletes);
  await expect(flowNotice(page)).toHaveText(remedy.retries);
  await expect(flowControl(page)).toHaveText('Start');
  expect((await page.evaluate((rk) => window.flow.state(rk), repo)).status).toBe('not_started');
  expect(readFileSync(lockFile, 'utf8')).toBe(planted);
});

test('an unusable lock directory blocks neither Start nor Terminate, and the file in its place is left as found', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const repo = seededRepo(harness, 'agent-term-e2e-a3-lock-unusable-');
  const lockRoot = worktreeLockRoot(harness.home);
  mkdirSync(flowHomeDir(harness.home), { recursive: true });
  const planted = 'not a lock directory\n';
  writeFileSync(lockRoot, planted);

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('fallback-first', { timeout: 10_000 });

  await flowControl(page).click();
  await expect(flowControl(page)).toHaveText('Advance', { timeout: 10_000 });
  await terminateRun(page);
  await expect(flowControl(page)).toHaveText('Start', { timeout: 10_000 });
  expect(readFileSync(lockRoot, 'utf8')).toBe(planted);
});

test('a Terminate while a live peer holds the worktree lock is refused, shows its reason once, and the run stays in progress', { tag: '@ownapp' }, async () => {
  const harness = createFlowPickerHarness();
  h = harness;
  const repo = seededRepo(harness, 'agent-term-e2e-a3-lock-held-');

  const page = await harness.launch();
  await harness.cdInto(repo);
  await expect(harness.stepName(1)).toHaveText('fallback-first', { timeout: 10_000 });
  await flowControl(page).click();
  await expect(flowControl(page)).toHaveText('Advance', { timeout: 10_000 });

  const lockFile = worktreeLockFile(worktreeLockRoot(harness.home), repo);
  mkdirSync(dirname(lockFile), { recursive: true });
  writeFileSync(lockFile, serializeLockHolder(currentLockHolder()));
  await terminateRun(page);

  await expect(flowNotice(page)).toContainText('Another Agent Terminal window', { timeout: 10_000 });
  await expect(flowNotice(page)).toHaveCount(1);
  const remedy = unidentifiedHolderRemedy(lockFile);
  await expect(flowNotice(page)).not.toContainText(remedy.path);
  await expect(flowNotice(page)).not.toHaveText(remedy.deletes);
  await expect(flowControl(page)).toHaveText('Advance');
  const next = await page.evaluate((rk) => window.flow.state(rk), repo);
  expect(next.status).toBe('in_progress');
  expect(next.notice).toBeUndefined();
});
