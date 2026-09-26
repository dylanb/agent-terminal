/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { flowHomeDir } from '../../src/main/flow';
import { readActiveFlow } from '../../src/main/activeFlowPointer';
import { currentLockHolder, serializeLockHolder, worktreeLockFile, worktreeLockRoot } from '../../src/main/worktreeLock';
import { createFlowPickerHarness, type FlowPickerHarness } from './flowPickerHarness';

// A3 (#134) T6c — only a worktree lock held by a live peer blocks Start, the pointer write or Terminate; every
// Terminate takes the lock (T6b).

let h: FlowPickerHarness | undefined;
test.afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

const flowControl = (page: Page): Locator => page.locator('#flow-strip .flow-control');
const flowTerminate = (page: Page): Locator => page.locator('#flow-strip .flow-terminate');
const flowNotice = (page: Page): Locator => page.locator('#flow-strip .flow-notice');
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

test('a lockfile whose holder cannot be identified blocks neither the pointer write nor Start, and is left as found', { tag: '@ownapp' }, async () => {
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

  expect(await page.evaluate((rk) => window.flow.setActiveFlow(rk, 'lock-flow'), repo)).toEqual({ ok: true });
  expect(readActiveFlow(repo)).toEqual({ kind: 'value', id: 'lock-flow' });
  await expect(harness.stepName(1)).toHaveText('lock-first', { timeout: 10_000 });
  await flowControl(page).click();
  await expect(flowControl(page)).toHaveText('Advance', { timeout: 10_000 });
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
  await expect(flowControl(page)).toHaveText('Advance');
  const next = await page.evaluate((rk) => window.flow.state(rk), repo);
  expect(next.status).toBe('in_progress');
  expect(next.notice).toBeUndefined();
});
