/// <reference lib="dom" />
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: ElectronApplication;
let page: Page;
let home: string;
let cleanup: string[];

const termRows = () => page.locator('.xterm-rows');
const statusBar = () => page.locator('#status-bar');
const statusTitle = () => page.locator('#status-bar [data-sb-title]');
const statusAlert = () => page.locator('#status-bar [data-status-alert]');
const flowStepName = () => page.locator('#flow-strip .flow.vert .stn').nth(1).locator('.nm');
const flowControl = () => page.locator('#flow-strip .flow-control');

async function launch(): Promise<void> {
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, APP_SHELL: 'bash', HOME: home, APP_SUBMIT_DELAY_MS: '100' },
  });
  page = await app.firstWindow();
  await expect(termRows()).not.toHaveText('', { timeout: 15_000 });
}

async function relaunch(): Promise<void> {
  await app.close();
  await launch();
}

async function typeCommand(command: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await page.keyboard.type(command, { delay: 20 });
  await page.keyboard.press('Enter');
}

async function enterRepo(repo: string, expectedStep?: string): Promise<void> {
  await typeCommand(`cd "${repo}"`);
  if (expectedStep) await expect(flowStepName()).toHaveText(expectedStep, { timeout: 10_000 });
  else await expect(statusTitle()).toBeVisible({ timeout: 10_000 });
}

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

function seedLoopRepo(prefix: string): { dir: string; stateFile: string } {
  const dir = temp(prefix);
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, '.agent-terminal'), { recursive: true });
  writeFileSync(
    join(dir, '.agent-terminal', 'flow.yaml'),
    'name: dev-flow\nsteps:\n  - id: groom\n    kind: manual\n  - id: build\n    kind: loop\n    loop: impl-loop\n',
  );
  writeFileSync(join(dir, '.agent-loop.yaml'), 'loops:\n  impl-loop: ./impl-loop.yaml\n');
  writeFileSync(
    join(dir, 'impl-loop.yaml'),
    'name: impl-loop\nschema_version: "4"\ngates:\n' +
      '  - id: awaiting-human-pr-approval\n    kind: approve-required\n    human_options: [approve, request-changes, impasse]\n    next_status_on_approve: awaiting-team-review\n' +
      '  - id: awaiting-human-impl-triage\n    kind: triage\n    human_options: [approve, request-changes, impasse]\n    next_status_on_approve: awaiting-team-review\n' +
      '  - id: awaiting-team-review\n    kind: terminal\n    human_options: []\n',
  );
  const loopDir = join(dir, '.agent-loop');
  mkdirSync(loopDir, { recursive: true });
  return { dir, stateFile: join(loopDir, 'state.yaml') };
}

test.beforeEach(async () => {
  cleanup = [];
  home = temp('agent-term-e2e-statusbar-home-');
  await launch();
});

test.afterEach(async () => {
  await app.close();
  for (const dir of cleanup.reverse()) rmSync(dir, { recursive: true, force: true });
});

test('is always visible and enters attention only while the loop needs a human (§22.3.1 / §24.2.3 T4)', async () => {
  const { dir, stateFile } = seedLoopRepo('agent-term-e2e-statusbar-');
  writeFileSync(stateFile, 'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 9\nstatus: awaiting-human-pr-approval\n');

  await expect(statusBar()).toBeVisible();
  await expect(statusTitle()).toBeVisible();
  await expect(statusAlert()).toHaveCount(0);
  await enterRepo(dir, 'groom');
  await flowControl().click();
  await flowControl().click();
  await expect(statusAlert()).toContainText('awaiting-human-pr-approval', { timeout: 10_000 });
  await expect(statusTitle()).toContainText('PR #179');
  await expect(page.locator('#status-bar [data-attn-dismiss]')).toHaveCount(0);

  await statusAlert().click();
  await expect(page.locator('#app')).toHaveClass(/\bloop-open\b/);
  await expect(page.locator('#loop-panel')).toContainText('awaiting-human-pr-approval');

  writeFileSync(stateFile, 'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 11\nstatus: awaiting-team-review\n');
  await expect(statusAlert()).toHaveCount(0, { timeout: 10_000 });
  await expect(statusBar()).toBeVisible();
});

test('persists a user title across relaunch and keeps it while a PR outranks it (§22.3.1)', async () => {
  const { dir, stateFile } = seedLoopRepo('agent-term-e2e-sbname-');
  await enterRepo(dir, 'groom');
  await statusTitle().click();
  const editor = page.locator('#status-bar input[data-sb-title-edit]');
  await editor.fill('Refactor the shadow parser');
  await editor.press('Enter');
  await expect(statusTitle()).toHaveText('Refactor the shadow parser');
  await expect.poll(() => readFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), 'utf8')).toContain('Refactor the shadow parser');

  await relaunch();
  await enterRepo(dir, 'groom');
  await expect(statusTitle()).toHaveText('Refactor the shadow parser');
  writeFileSync(stateFile, 'schema_version: 4\npr: 179\nbranch: agent-loop/issue-176\niteration: 1\nstatus: impl-draft\n');
  await flowControl().click();
  await flowControl().click();
  await expect(statusTitle()).toContainText('PR #179', { timeout: 10_000 });
  expect(readFileSync(join(dir, '.agent-terminal', 'flow-state.yaml'), 'utf8')).toContain('Refactor the shadow parser');
});

test('keeps title, activity, and alert perceptible under pressure and honors reduced motion (§22.3.1)', async () => {
  const { dir, stateFile } = seedLoopRepo('agent-term-e2e-sblayout-');
  writeFileSync(stateFile, 'schema_version: 4\nbranch: agent-loop/issue-176\niteration: 9\nstatus: awaiting-human-pr-approval\n');
  await enterRepo(dir, 'groom');
  const height = async () => (await statusBar().boundingBox())!.height;
  const idleHeight = await height();
  await statusTitle().click();
  const editor = page.locator('#status-bar input[data-sb-title-edit]');
  await editor.fill('Refactor the shadow parser and its quiescence detector');
  expect(await height()).toBe(idleHeight);
  await editor.press('Enter');
  await flowControl().click();
  await flowControl().click();
  await expect(statusAlert()).toBeVisible({ timeout: 10_000 });
  expect(await height()).toBe(idleHeight);

  await page.locator('#status-bar .sb-activity').evaluate((region) => {
    const phrase = document.createElement('span');
    phrase.className = 'phrase';
    phrase.textContent = 'Running every implementation review persona';
    const spinner = document.createElement('span');
    spinner.className = 'spin';
    spinner.setAttribute('aria-hidden', 'true');
    region.replaceChildren(phrase, spinner);
  });
  const spinner = page.locator('#status-bar .spin');
  expect(await spinner.evaluate((el) => getComputedStyle(el, '::after').content)).not.toBe('none');
  expect(await spinner.evaluate((el) => getComputedStyle(el, '::after').animationName)).not.toBe('none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await spinner.evaluate((el) => getComputedStyle(el, '::after').animationName)).toBe('none');

  await page.setViewportSize({ width: 420, height: 700 });
  const titleBox = (await statusTitle().boundingBox())!;
  const phraseBox = (await page.locator('#status-bar .sb-activity .phrase').boundingBox())!;
  const barBox = (await statusBar().boundingBox())!;
  const alertBox = (await statusAlert().boundingBox())!;
  expect(titleBox.width).toBeGreaterThan(0);
  expect(phraseBox.width).toBeGreaterThan(0);
  expect(await statusTitle().evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.locator('#status-bar .sb-activity .phrase').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(alertBox.x + alertBox.width).toBeLessThanOrEqual(barBox.x + barBox.width + 1);
  expect(await height()).toBe(idleHeight);
});

test('names a directory with no flow and restores the name after relaunch (§22.3.1)', async () => {
  const plain = temp('agent-term-e2e-noflow-');
  await enterRepo(plain);
  await statusTitle().click();
  const editor = page.locator('#status-bar input[data-sb-title-edit]');
  await editor.fill('Spike the shadow parser');
  await editor.press('Enter');
  await expect(statusTitle()).toHaveText('Spike the shadow parser');
  await expect.poll(() => readFileSync(join(plain, '.agent-terminal', 'flow-state.yaml'), 'utf8')).toContain('Spike the shadow parser');

  await relaunch();
  await enterRepo(plain);
  await expect(statusTitle()).toHaveText('Spike the shadow parser');
});

test('rejects unregistered and malformed title-write targets (CWE-73)', async () => {
  const unregistered = temp('agent-term-e2e-unregistered-');
  const currentRepo = await page.evaluate(async () => (await window.monitor.currentRepo())!.repoKey);
  const outcomes = await page.evaluate(async (cases) =>
    Promise.all(cases.map(async ({ repoKey, title }) => {
      try {
        await window.flow.setTitle(repoKey, title);
        return 'resolved';
      } catch {
        return 'rejected';
      }
    })), [
      { repoKey: unregistered, title: 'Must not land' },
      { repoKey: '../relative', title: 'Must not land' },
      { repoKey: currentRepo, title: 'x'.repeat(201) },
    ]);
  expect(outcomes).toEqual(['rejected', 'rejected', 'rejected']);
  expect(existsSync(join(unregistered, '.agent-terminal', 'flow-state.yaml'))).toBe(false);
});

test('surfaces a failed title write and rolls back the optimistic name (§22.3.1)', async () => {
  const plain = temp('agent-term-e2e-nameerr-');
  const elsewhere = temp('agent-term-e2e-nameerr-else-');
  symlinkSync(elsewhere, join(plain, '.agent-terminal'));
  await enterRepo(plain);
  await statusTitle().click();
  const editor = page.locator('#status-bar input[data-sb-title-edit]');
  await editor.fill('Never lands');
  await editor.press('Enter');
  const errorDialog = page.locator('#flow-error-host .flow-modal');
  await expect(errorDialog).toContainText('Could not save the name', { timeout: 10_000 });
  await expect(statusTitle()).not.toHaveText('Never lands');
});
