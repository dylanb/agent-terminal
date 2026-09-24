/// <reference lib="dom" />
// The @ownapp launch harness for A3 (#134) flow-picker e2e (§23.4). Home, repos and user-data dir are kept
// across a relaunch so persisted state is what the relaunched app reads.

import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { createCatalogFixture } from '../helpers/catalogFixture';
import { createWorktreeFixture } from '../helpers/worktreeFixture';
import { flowCatalogDir, type FlowInputDef } from '../../src/main/flow';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { shellQuote } from '../../src/shared/shellQuote';

export interface FlowPickerHarness {
  home: string;
  /** A fresh repo with its own `.git` (§16.3), realpath'd so it matches the shell's `pwd`. */
  repo(prefix: string): string;
  seedGlobalEntry(id: string, stepIds: string[], inputs?: Record<string, FlowInputDef[]>): void;
  seedRepoEntry(repo: string, id: string, stepIds: string[], inputs?: Record<string, FlowInputDef[]>): void;
  /** Seed the global fallback `<home>/.agent-terminal/flow.yaml`. */
  seedGlobalFallback(stepIds: string[]): void;
  /** Seed a local `<repo>/.agent-terminal/flow.yaml`. */
  seedLocalFlow(repo: string, stepIds: string[]): void;
  selectFlow(repo: string, id: string): void;
  launch(): Promise<Page>;
  /** Close the running app, keeping home, repos and user data, so a test can change persisted state before the
   *  next launch(). */
  close(): Promise<void>;
  relaunch(): Promise<Page>;
  page(): Page;
  app(): ElectronApplication;
  /** `cd` the terminal into `dir` and wait for the shell to settle, so the strip follows that repo. */
  cdInto(dir: string): Promise<void>;
  /** The strip's step-name label at station `i` (station 0 is the Not-started bookend). */
  stepName(i: number): Locator;
  dispose(): Promise<void>;
}

export function createFlowPickerHarness(): FlowPickerHarness {
  const wt = createWorktreeFixture();
  const catalog = createCatalogFixture();
  const home = realpathSync(wt.makeFirstRunWorktree('agent-term-e2e-a3-home'));
  const userDataDir = mkdtempSync(join(tmpdir(), 'agent-term-e2e-a3-ud-'));
  const shellHome = mkdtempSync(join(tmpdir(), 'agent-term-e2e-a3-shellhome-'));
  let running: { app: ElectronApplication; page: Page } | null = null;

  const current = (): { app: ElectronApplication; page: Page } => {
    if (running === null) throw new Error('the harness app is not running; call launch() first');
    return running;
  };

  let launched: ElectronApplication | null = null;

  const launch = async (): Promise<Page> => {
    if (launched !== null) throw new Error('the harness app is already running; use relaunch()');
    const app = await electron.launch({
      args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
      env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', HOME: shellHome, APP_HOME_DIR: home },
    });
    launched = app;
    running = { app, page: await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS }) };
    await expect(running.page.locator('.xterm-rows')).not.toHaveText('', { timeout: 15_000 });
    return running.page;
  };

  const close = async (): Promise<void> => {
    const was = launched;
    launched = null;
    running = null;
    await was?.close();
  };

  return {
    home,
    repo(prefix) {
      const dir = realpathSync(wt.makeFirstRunWorktree(prefix));
      mkdirSync(join(dir, '.git'), { recursive: true });
      return dir;
    },
    seedGlobalEntry(id, stepIds, inputs) {
      catalog.addEntryWithSteps(flowCatalogDir(home), id, stepIds, inputs);
    },
    seedRepoEntry(repo, id, stepIds, inputs) {
      catalog.addEntryWithSteps(flowCatalogDir(repo), id, stepIds, inputs);
    },
    seedGlobalFallback(stepIds) {
      wt.writeFlowHome(home, { name: 'global-fallback', stepIds });
    },
    seedLocalFlow(repo, stepIds) {
      wt.writeFlowHome(repo, { name: 'local-flow', stepIds });
    },
    selectFlow(repo, id) {
      writeActiveFlow(repo, id);
    },
    launch,
    close,
    async relaunch() {
      await close();
      return launch();
    },
    page: () => current().page,
    app: () => current().app,
    async cdInto(dir) {
      const { page } = current();
      await page.locator('.xterm-screen').click();
      await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
      await page.keyboard.type(`cd ${shellQuote(dir)} && pwd`, { delay: 20 });
      await page.keyboard.press('Enter');
      await expect(
        page.locator('.xterm-rows > div').filter({ hasText: new RegExp(`^\\s*${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`) }),
      ).not.toHaveCount(0);
      await expect(page.locator('.status-chip[data-status="agent"]')).toContainText('quiet', { timeout: 6_000 });
    },
    stepName(i) {
      return current().page.locator('#flow-strip .flow.vert .stn').nth(i).locator('.nm');
    },
    async dispose() {
      try {
        await close();
      } finally {
        rmSync(userDataDir, { recursive: true, force: true });
        rmSync(shellHome, { recursive: true, force: true });
        catalog.cleanup();
        wt.cleanup();
      }
    },
  };
}
