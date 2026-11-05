/// <reference lib="dom" />
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { CH, SESSION_ID, type FlowBootstrapErrorMsg } from '../../src/shared/ipc';
import { shellQuote } from '../../src/shared/shellQuote';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { writeRepoConditions, type RepoConditionsFixture } from '../helpers/setupRepoConditions';
import { createWorktreeFixture, type WorktreeFixture } from '../helpers/worktreeFixture';
import { electron } from './registeredElectron';
import { createSetupCheckMachine, failingCheckIgnoreGit, type SetupCheckMachine } from './setupCheckEnv';

// The startup setup check (#290): a repository that fails a condition raises a blocking popup listing each
// failing condition, at startup and on the first `cd` into it.

let machine: SetupCheckMachine;
let git: GitRepoFixture;
let worktrees: WorktreeFixture;
let app: ElectronApplication | undefined;
const scratch: string[] = [];
const cleanups: Array<() => void> = [];

test.beforeEach(() => {
  machine = createSetupCheckMachine();
  git = createGitRepoFixture();
  worktrees = createWorktreeFixture();
});

test.afterEach(async () => {
  await app?.close();
  app = undefined;
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  worktrees.cleanup();
  git.cleanup();
  machine.dispose();
});

const repoIn = (conditions: RepoConditionsFixture): string => {
  const repo = realpathSync(git.makeGitRepo('setup-check-e2e'));
  writeRepoConditions(repo, conditions);
  return repo;
};

async function launchIn(dir: string, env: Record<string, string | undefined> = machine.env): Promise<Page> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'setup-check-ud-'));
  scratch.push(userDataDir);
  app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, APP_SHELL: 'bash', APP_SUBMIT_DELAY_MS: '100', ...env, APP_LAUNCH_DIR: dir },
  });
  const page = await app.firstWindow({ timeout: WINDOW_TIMEOUT_MS });
  await expect(page.locator('.xterm-rows')).not.toHaveText('', { timeout: 15_000 });
  return page;
}

/** The setup popup raised for `repoKey`: the dialog that names it. */
const popupFor = (page: Page, repoKey: string): Locator => page.getByRole('dialog').filter({ hasText: repoKey });
const entriesOf = (popup: Locator): Locator => popup.getByRole('listitem');

async function cdInto(page: Page, dir: string): Promise<void> {
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(`cd ${shellQuote(dir)} && pwd`, { delay: 20 });
  await page.keyboard.press('Enter');
}

/** From now on, the text of every dialog on the page, in the order each appeared, including any open now. */
async function recordDialogs(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const seen: string[] = [];
    const dialogsIn = (node: Element): Element[] => [
      ...(node.matches('[role="dialog"]') ? [node] : []),
      ...node.querySelectorAll('[role="dialog"]'),
    ];
    for (const el of dialogsIn(document.body)) seen.push(el.textContent ?? '');
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) for (const el of dialogsIn(node)) seen.push(el.textContent ?? '');
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
    (window as unknown as { setupDialogsSeen: string[] }).setupDialogsSeen = seen;
  });
  return () => page.evaluate(() => [...(window as unknown as { setupDialogsSeen: string[] }).setupDialogsSeen]);
}

test('e2e launches leave the setup check off unless the test turns it on', { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: false, capabilities: 'absent' });
  const { APP_SETUP_CHECK: _on, ...defaultEnv } = machine.env;
  const page = await launchIn(repo, defaultEnv);

  const reply = await page.evaluate((repoKey) => window.setup?.status(repoKey) ?? null, repo);

  expect(reply).toMatchObject({ ok: true, entries: [] });
});

const FAILING_KINDS: Array<{ title: string; conditions: RepoConditionsFixture }> = [
  { title: 'has no loop-capabilities.yaml (AC1)', conditions: { ignored: true, capabilities: 'absent' } },
  { title: 'has a loop-capabilities.yaml the reader rejects (AC2)', conditions: { ignored: true, capabilities: 'malformed' } },
  { title: 'has a loop-capabilities.yaml the reader cannot read as a file (AC2)', conditions: { ignored: true, capabilities: 'not-a-file' } },
  { title: 'has a symlinked loop-capabilities.yaml (AC3)', conditions: { ignored: true, capabilities: 'symlink' } },
  { title: 'does not ignore .agent-terminal/ (AC4)', conditions: { ignored: false, capabilities: 'valid' } },
];

for (const { title, conditions } of FAILING_KINDS) {
  test(`starting in a repository that ${title} raises the setup popup listing it`, { tag: '@ownapp' }, async () => {
    const repo = repoIn(conditions);
    const page = await launchIn(repo);

    await expect(entriesOf(popupFor(page, repo))).toHaveCount(1);
  });
}

test("starting in a repository where git cannot answer the ignore question lists that the app couldn't check it (AC6)", { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: true, capabilities: 'valid' });
  const failingGit = failingCheckIgnoreGit();
  cleanups.push(() => failingGit.dispose());
  const page = await launchIn(repo, { ...machine.env, PATH: `${failingGit.binDir}${delimiter}${process.env.PATH ?? ''}` });

  await expect(entriesOf(popupFor(page, repo))).toHaveCount(1);
});

test('a repository failing both repository conditions lists each with its own message', { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: false, capabilities: 'absent' });
  const page = await launchIn(repo);
  const entries = entriesOf(popupFor(page, repo));

  await expect
    .poll(async () => new Set((await entries.allTextContents()).map((t) => t.trim()).filter(Boolean)).size)
    .toBe(2);
});

test('starting outside a git repository raises no repository popup; the first cd into a failing one does (AC9)', { tag: '@ownapp' }, async () => {
  const start = realpathSync(worktrees.makeFirstRunWorktree('setup-check-plain-start'));
  writeRepoConditions(start, { ignored: false, capabilities: 'malformed' });
  worktrees.writeFlowHome(start, { name: 'start-dir-flow', stepIds: ['start-dir-step'] });
  const probe = repoIn({ ignored: false, capabilities: 'absent' });
  const page = await launchIn(start);
  await expect(page.locator('#flow-strip')).toContainText('start-dir-step');
  const seen = await recordDialogs(page);
  const unentered = await page.evaluate((repoKey) => window.setup?.status(repoKey) ?? null, probe);
  expect.soft(unentered).toMatchObject({ ok: false });

  await cdInto(page, probe);

  await expect.poll(async () => (await seen())[0] ?? '').toContain(probe);
});

/** Types a `cd` into whatever holds keyboard focus, without clicking the terminal first, and prints a marker
 *  the typed line itself does not contain. */
async function typeCd(page: Page, dir: string, marker: string): Promise<void> {
  await page.keyboard.type(`cd ${shellQuote(dir)} && printf '%s-%s\\n' at ${marker}`, { delay: 20 });
  await page.keyboard.press('Enter');
}

const focusIsInside = (popup: Locator): Promise<boolean> => popup.evaluate((el) => el.contains(document.activeElement));
const focusIsOnTerminal = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') === true);

test('re-entering a repository already checked this session raises no second popup (AC10)', { tag: '@ownapp' }, async () => {
  const passing = repoIn({ ignored: true, capabilities: 'valid' });
  const failing = repoIn({ ignored: false, capabilities: 'absent' });
  const probe = repoIn({ ignored: true, capabilities: 'absent' });
  const page = await launchIn(passing);
  const seen = await recordDialogs(page);
  await cdInto(page, failing);
  const popup = popupFor(page, failing);
  await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();

  await typeCd(page, passing, 'back');
  await expect(page.locator('.xterm-rows')).toContainText('at-back');
  await typeCd(page, failing, 'again');
  await expect(page.locator('.xterm-rows')).toContainText('at-again');
  await typeCd(page, probe, 'probe');

  const named = async () => (await seen()).map((text) => [failing, probe].find((repo) => text.includes(repo)) ?? text);
  await expect.poll(named).toEqual([failing, probe]);
});

test('the popup is announced as a modal dialog, keeps Tab inside, and Escape returns focus to the terminal (AC11)', { tag: '@ownapp' }, async () => {
  const passing = repoIn({ ignored: true, capabilities: 'valid' });
  const failing = repoIn({ ignored: false, capabilities: 'absent' });
  const page = await launchIn(passing);
  await cdInto(page, failing);
  const popup = popupFor(page, failing);
  await expect(popup).toBeVisible();
  const soft = expect.configure({ soft: true });

  await soft(popup).toHaveAttribute('aria-modal', 'true');
  await soft(popup).toHaveAccessibleName(/\S/);
  await soft.poll(() => focusIsInside(popup)).toBe(true);
  for (const key of ['Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    soft(await focusIsInside(popup)).toBe(true);
  }
  await page.keyboard.press('Escape');
  await soft(popup).toBeHidden();
  await soft.poll(() => focusIsOnTerminal(page)).toBe(true);
});

test('Close dismisses nothing: a restart with the same failures lists them again (AC16)', { tag: '@ownapp' }, async () => {
  const failing = repoIn({ ignored: false, capabilities: 'absent' });
  let page = await launchIn(failing);
  const popup = popupFor(page, failing);
  await expect(entriesOf(popup)).toHaveCount(2);

  await popup.getByRole('button', { name: 'Close' }).click();
  await expect.soft(popup).toBeHidden();
  await app?.close();
  page = await launchIn(failing);

  await expect(entriesOf(popupFor(page, failing))).toHaveCount(2);
});

/** Raises the app's own bootstrap-failure alertdialog, through the push main sends when a bootstrap fails. */
async function raiseAppErrorDialog(repoKey: string): Promise<void> {
  const msg: FlowBootstrapErrorMsg = { sessionId: SESSION_ID, repoKey, step: 'setup-check-e2e-step', reason: 'scripted bootstrap failure' };
  await app!.evaluate(({ BrowserWindow }, { channel, msg }) => BrowserWindow.getAllWindows()[0].webContents.send(channel, msg), {
    channel: CH.flowOnBootstrapError,
    msg,
  });
}

/** From now on, for each dialog added to the page, how many `aria-modal` dialogs were open once it was. */
async function recordModalCounts(page: Page): Promise<() => Promise<number[]>> {
  await page.evaluate(() => {
    const counts: number[] = [];
    new MutationObserver((records) => {
      const added = records.some((record) =>
        [...record.addedNodes].some((node) => node instanceof Element && (node.matches('[aria-modal="true"]') || node.querySelector('[aria-modal="true"]') !== null)),
      );
      if (added) counts.push(document.querySelectorAll('[aria-modal="true"]').length);
    }).observe(document.body, { childList: true, subtree: true });
    (window as unknown as { modalCounts: number[] }).modalCounts = counts;
  });
  return () => page.evaluate(() => [...(window as unknown as { modalCounts: number[] }).modalCounts]);
}

test('a popup due while another app dialog is open waits, and opens once that dialog closes', { tag: '@ownapp' }, async () => {
  const passing = repoIn({ ignored: true, capabilities: 'valid' });
  const failing = repoIn({ ignored: false, capabilities: 'absent' });
  const page = await launchIn(passing);
  const counts = await recordModalCounts(page);
  await raiseAppErrorDialog(passing);
  const other = page.getByRole('alertdialog').filter({ hasText: 'scripted bootstrap failure' });
  await expect(other).toBeVisible();

  await page.evaluate((line) => window.term.input(line), `cd ${shellQuote(failing)} && printf '%s-%s\\n' at blocked\r`);
  await expect(page.locator('.xterm-rows')).toContainText('at-blocked');
  await expect.poll(() => page.evaluate((repoKey) => window.setup.status(repoKey).then((r) => r.ok), failing)).toBe(true);
  await other.getByRole('button', { name: 'Dismiss' }).dispatchEvent('click');
  await expect(popupFor(page, failing)).toBeVisible();

  expect(await counts()).toEqual([1, 1]);
});

test("closing the popup after the element that opened it left the page lands focus in the app, not on the page body", { tag: '@ownapp' }, async () => {
  const passing = repoIn({ ignored: true, capabilities: 'valid' });
  const failing = repoIn({ ignored: false, capabilities: 'absent' });
  const page = await launchIn(passing);
  await cdInto(page, failing);
  const popup = popupFor(page, failing);
  await expect(popup).toBeVisible();
  await page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.remove());

  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();

  await expect.poll(() => page.evaluate(() => document.activeElement !== null && document.activeElement !== document.body)).toBe(true);
});
