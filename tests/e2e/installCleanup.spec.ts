import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { stopApp } from './stopApp';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { electron } from './registeredElectron';

// §18.1 — Install examples offers, behind its own unchecked box, to remove what the retired feature-dev and
// feature-dev-v2 flows left in an installation.

let app: ElectronApplication | undefined;
let page: Page;
const cleanup: string[] = [];

test.afterEach(async ({}, testInfo) => {
  await stopApp(app, testInfo);
  app = undefined;
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
};

function plant(file: string, body = 'old\n'): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
}

const view = () => page.locator('#install-examples-view');
const retiredBox = () => view().locator('.flow-modal input[type="checkbox"][data-retired]');

async function openInstall(home: string, configDir: string): Promise<void> {
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...(process.env as Record<string, string>),
      APP_SHELL: 'bash',
      HOME: home,
      CLAUDE_CONFIG_DIR: configDir,
      CODEX_HOME: join(home, '.codex'),
      APP_SUBMIT_DELAY_MS: '100',
    },
  });
  page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: 15_000 });
  await page.locator('[data-viewbtn="4"]').click();
  await expect(view()).toBeVisible();
  await view().locator('.kprofile button').click();
  await expect(view().locator('.flow-modal')).toBeVisible({ timeout: 15_000 });
}

function seed(): { home: string; configDir: string; remnants: string[]; keeper: string } {
  const home = tmp('agent-term-e2e-retired-home-');
  const configDir = tmp('agent-term-e2e-retired-cfg-');
  const remnants = [
    plant(join(home, '.agent-terminal', 'flows', 'feature-dev-v2', 'flow.yaml')),
    plant(join(configDir, 'loops-v2', 'feature-dev-v2', 'green-loop', 'green-loop.yaml')),
    plant(join(configDir, 'agents', 'plan-polish-loop--review-plan-intent.md')),
  ];
  const keeper = plant(join(configDir, 'agents', 'my-agent.md'), 'mine\n');
  return { home, configDir, remnants, keeper };
}

/** The fallback flow.yaml an older build seeded: a valid flow still named for a retired one. */
function seedRetiredFallback(home: string): void {
  const shipped = readFileSync(join('example', 'flows', 'feature-dev-v3', 'flow.yaml'), 'utf8');
  plant(join(home, '.agent-terminal', 'flow.yaml'), shipped.replace(/^name: .*$/m, 'name: feature-dev-v2'));
}

test('ticking the removal deletes what the retired flows left, reports it, and keeps the operator’s own files', { tag: '@ownapp' }, async () => {
  const { home, configDir, remnants, keeper } = seed();
  seedRetiredFallback(home);
  await openInstall(home, configDir);

  await expect(retiredBox()).not.toBeChecked();
  await expect(view().locator('.flow-modal')).toContainText('Your fallback flow is still the retired feature-dev-v2, which may use what these remove');
  await expect(view().locator('.flow-modal')).toContainText('plan-polish-loop--review-plan-intent.md');
  await retiredBox().check();
  await view().locator('.flow-modal button.confirm').click();

  await expect(view().locator('[role="status"]')).toContainText('removed 3', { timeout: 15_000 });
  await expect(view().locator('.install-report [data-destination="agents"]')).toContainText('removed 1: plan-polish-loop--review-plan-intent.md');
  for (const r of remnants) expect(existsSync(r), r).toBe(false);
  expect(existsSync(join(home, '.agent-terminal', 'flows', 'feature-dev'))).toBe(false);
  expect(readFileSync(keeper, 'utf8')).toBe('mine\n');
  expect(existsSync(join(home, '.agent-terminal', 'flows', 'feature-dev-v3', 'flow.yaml'))).toBe(true);
});

test('installing without ticking the removal keeps every leftover', { tag: '@ownapp' }, async () => {
  const { home, configDir, remnants } = seed();
  await openInstall(home, configDir);

  await expect(view().locator('.flow-modal')).not.toContainText('fallback flow');
  await view().locator('.flow-modal button.confirm').click();

  await expect(view().locator('[role="status"]')).toContainText('created', { timeout: 15_000 });
  await expect(view().locator('[role="status"]')).not.toContainText('removed');
  for (const r of remnants) expect(existsSync(r), r).toBe(true);
});
