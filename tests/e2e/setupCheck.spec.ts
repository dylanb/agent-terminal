/// <reference lib="dom" />
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { CH, SESSION_ID, type FlowBootstrapErrorMsg } from '../../src/shared/ipc';
import { shellQuote } from '../../src/shared/shellQuote';
import { REPO_SETUP_FLOW_ID } from '../../src/shared/setupCheck';
import { writeActiveFlow } from '../../src/main/activeFlowPointer';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { writeRepoConditions, type RepoConditionsFixture } from '../helpers/setupRepoConditions';
import { snapshotTree } from '../helpers/treeSnapshot';
import { createWorktreeFixture, type WorktreeFixture } from '../helpers/worktreeFixture';
import { electron } from './registeredElectron';
import { seedFakeAgentV2 } from './fakeTools';
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

const installView = (page: Page): Locator => page.locator('#install-examples-view');

/** Installs the bundled examples on this case's machine through the Settings view's Install examples action, in
 *  a launch with the setup check off so no popup stands over the view, and closes that launch. Every launch after
 *  it finds the examples condition passing. */
async function installExamplesThroughApp(): Promise<void> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'setup-check-install-')));
  scratch.push(dir);
  const page = await launchIn(dir, { ...machine.env, APP_SETUP_CHECK: 'off' });
  await page.locator('[data-viewbtn="4"]').click();
  await installView(page).getByRole('button', { name: /^Install examples/ }).click();
  await expect(installView(page).getByRole('status')).toContainText('Installed examples');
  await app?.close();
  app = undefined;
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
  test(`starting in a repository that ${title} raises the setup popup listing it, beside the examples entry`, { tag: '@ownapp' }, async () => {
    const repo = repoIn(conditions);
    const page = await launchIn(repo);

    await expect(entriesOf(popupFor(page, repo))).toHaveCount(2);
  });
}

test("starting in a repository where git cannot answer the ignore question lists that the app couldn't check it (AC6)", { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: true, capabilities: 'valid' });
  const failingGit = failingCheckIgnoreGit();
  cleanups.push(() => failingGit.dispose());
  const page = await launchIn(repo, { ...machine.env, PATH: `${failingGit.binDir}${delimiter}${process.env.PATH ?? ''}` });

  await expect(entriesOf(popupFor(page, repo))).toHaveCount(2);
});

test('a repository failing both repository conditions lists each with its own message, beside the examples entry', { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: false, capabilities: 'absent' });
  const page = await launchIn(repo);
  const entries = entriesOf(popupFor(page, repo));

  await expect
    .poll(async () => new Set((await entries.allTextContents()).map((t) => t.trim()).filter(Boolean)).size)
    .toBe(3);
});

test('starting outside a git repository raises no repository popup; the first cd into a failing one does (AC9)', { tag: '@ownapp' }, async () => {
  const start = realpathSync(worktrees.makeFirstRunWorktree('setup-check-plain-start'));
  writeRepoConditions(start, { ignored: false, capabilities: 'malformed' });
  worktrees.writeFlowHome(start, { name: 'start-dir-flow', stepIds: ['start-dir-step'] });
  const probe = repoIn({ ignored: false, capabilities: 'absent' });
  await installExamplesThroughApp();
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
  await installExamplesThroughApp();
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
  await installExamplesThroughApp();
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
  await expect.soft(entriesOf(popup)).toHaveCount(3);

  await popup.getByRole('button', { name: 'Close' }).click();
  await expect.soft(popup).toBeHidden();
  await app?.close();
  page = await launchIn(failing);

  await expect(entriesOf(popupFor(page, failing))).toHaveCount(3);
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
  await installExamplesThroughApp();
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
  await installExamplesThroughApp();
  const page = await launchIn(passing);
  await cdInto(page, failing);
  const popup = popupFor(page, failing);
  await expect(popup).toBeVisible();
  await page.evaluate(() => document.querySelector('.xterm-helper-textarea')?.remove());

  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();

  await expect.poll(() => page.evaluate(() => document.activeElement !== null && document.activeElement !== document.body)).toBe(true);
});

const INSTALL = 'Install/update examples';

test('on a fresh machine, a repository passing its own conditions lists the examples entry, with Install/update examples (AC7, AC12)', { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: true, capabilities: 'valid' });
  const page = await launchIn(repo);
  const popup = popupFor(page, repo);

  await expect.soft(entriesOf(popup)).toHaveCount(1);
  await expect.soft(popup.getByRole('button', { name: INSTALL })).toBeVisible();
});

test('Install/update examples closes the popup and runs the install; after accepting every change a relaunch lists no examples entry (AC17)', { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: true, capabilities: 'absent' });
  let page = await launchIn(repo);
  const popup = popupFor(page, repo);
  await expect.soft(entriesOf(popup)).toHaveCount(2);

  await popup.getByRole('button', { name: INSTALL }).click();
  await expect.soft(popup).toBeHidden();
  await expect.soft(installView(page)).toBeVisible();
  await expect.soft(installView(page).getByRole('status')).toContainText('Installed examples');
  await app?.close();
  page = await launchIn(repo);
  await expect(popupFor(page, repo)).toBeVisible();

  const reply = await page.evaluate((repoKey) => window.setup.status(repoKey), repo);
  expect(reply).toMatchObject({ ok: true, entries: [{ condition: 'capabilities', failure: 'absent' }] });
});

test('with the examples installed and every condition passing, no popup appears (AC8)', { tag: '@ownapp' }, async () => {
  const passing = repoIn({ ignored: true, capabilities: 'valid' });
  worktrees.writeFlowHome(passing, { name: 'passing-repo-flow', stepIds: ['passing-repo-step'] });
  const probe = repoIn({ ignored: false, capabilities: 'absent' });
  await installExamplesThroughApp();
  const page = await launchIn(passing);
  await expect(page.locator('#flow-strip')).toContainText('passing-repo-step');
  const seen = await recordDialogs(page);

  await cdInto(page, probe);

  await expect.poll(async () => (await seen())[0] ?? '').toContain(probe);
});

test('starting outside a git repository on a fresh machine lists only the examples entry (AC9)', { tag: '@ownapp' }, async () => {
  const start = realpathSync(worktrees.makeFirstRunWorktree('setup-check-plain-examples'));
  writeRepoConditions(start, { ignored: false, capabilities: 'malformed' });
  const page = await launchIn(start);

  await expect.soft(entriesOf(page.getByRole('dialog'))).toHaveCount(1);
  const reply = await page.evaluate((dir) => window.setup.status(dir), start);
  expect.soft(reply).toMatchObject({ ok: true, isRepository: false, entries: [{ condition: 'examples', failure: 'stale' }] });
});

test('with the examples installed, a popup listing only repository entries offers no Install/update examples (AC12)', { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: false, capabilities: 'absent' });
  await installExamplesThroughApp();
  const page = await launchIn(repo);
  const popup = popupFor(page, repo);
  await expect(entriesOf(popup)).toHaveCount(2);

  await expect(popup.getByRole('button', { name: INSTALL })).toHaveCount(0);
});

test('after Install/update examples, focus rests on the Settings view\'s Install examples button (WCAG 2.4.3)', { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: true, capabilities: 'absent' });
  const page = await launchIn(repo);
  const popup = popupFor(page, repo);

  await popup.getByRole('button', { name: INSTALL }).click();
  await expect(installView(page).getByRole('status')).toContainText('Installed examples');

  await expect(installView(page).getByRole('button', { name: /^Install examples/ })).toBeFocused();
});

const FOR_REPO = "Don't show again for this repo";
const UNTIL_UPDATE = "Don't show again until the app updates";

/** Runs `cd` into `dir` in the terminal through the app's own input path, which reaches the shell whether or
 *  not a dialog holds focus, and waits until the shell has run it. */
async function shellCd(page: Page, dir: string, marker: string): Promise<void> {
  await page.evaluate((line) => window.term.input(line), `cd ${shellQuote(dir)} && printf '%s-%s\\n' at ${marker}\r`);
  await expect(page.locator('.xterm-rows')).toContainText(`at-${marker}`);
}

/** The repository each recorded dialog named, among `repos`, in the order the dialogs appeared. */
const namedAmong = (seen: () => Promise<string[]>, repos: string[]) => async (): Promise<string[]> =>
  (await seen()).map((text) => repos.find((repo) => text.includes(repo)) ?? text);

/** The text of the control that has focus inside `popup`, or null when focus is not on one of its buttons. */
const focusedControlIn = (popup: Locator): Promise<string | null> =>
  popup.evaluate((el) => {
    const active = document.activeElement;
    return active instanceof HTMLButtonElement && el.contains(active) ? (active.textContent ?? '').trim() : null;
  });

test("Don't show again for this repo silences it after a restart, and another failing repository still lists (AC13)", { tag: '@ownapp' }, async () => {
  const dismissed = repoIn({ ignored: false, capabilities: 'absent' });
  const other = repoIn({ ignored: false, capabilities: 'absent' });
  await installExamplesThroughApp();
  let page = await launchIn(dismissed);
  const popup = popupFor(page, dismissed);
  await expect(entriesOf(popup)).toHaveCount(2);

  await popup.getByRole('button', { name: FOR_REPO }).click();
  await expect.soft(popup).toBeHidden();
  await app?.close();
  page = await launchIn(dismissed);
  const seen = await recordDialogs(page);
  await shellCd(page, other, 'other');

  await expect.poll(namedAmong(seen, [dismissed, other])).toEqual([other]);
  await expect.soft(entriesOf(popupFor(page, other))).toHaveCount(2);
});

test("Don't show again until the app updates silences the examples entry after a same-version restart (AC14)", { tag: '@ownapp' }, async () => {
  const passing = repoIn({ ignored: true, capabilities: 'valid' });
  const probe = repoIn({ ignored: false, capabilities: 'absent' });
  let page = await launchIn(passing);
  const popup = popupFor(page, passing);
  await expect(entriesOf(popup)).toHaveCount(1);
  const running = await app!.evaluate(({ app: electronApp }) => electronApp.getVersion());
  const reply = await page.evaluate((repoKey) => window.setup.status(repoKey), passing);
  expect.soft(reply).toMatchObject({ ok: true, appVersion: running });

  await popup.getByRole('button', { name: UNTIL_UPDATE }).click();
  await expect.soft(popup).toBeHidden();
  await app?.close();
  page = await launchIn(passing);
  const seen = await recordDialogs(page);
  await shellCd(page, probe, 'probe');

  await expect.poll(namedAmong(seen, [passing, probe])).toEqual([probe]);
  await expect.soft(entriesOf(popupFor(page, probe))).toHaveCount(2);
});

const MIXED_DISMISSALS: Array<{ press: string; kept: string[]; gone: string[] }> = [
  { press: FOR_REPO, kept: [INSTALL, UNTIL_UPDATE, 'Close'], gone: [FOR_REPO] },
  { press: UNTIL_UPDATE, kept: [FOR_REPO, 'Close'], gone: [INSTALL, UNTIL_UPDATE] },
];

for (const { press, kept, gone } of MIXED_DISMISSALS) {
  test(`in a popup listing both kinds, ${press} leaves the other kind listed with its controls, and focus on one of them (AC14)`, { tag: '@ownapp' }, async () => {
    const repo = repoIn({ ignored: true, capabilities: 'absent' });
    const page = await launchIn(repo);
    const popup = popupFor(page, repo);
    await expect(entriesOf(popup)).toHaveCount(2);
    const soft = expect.configure({ soft: true });

    await popup.getByRole('button', { name: press }).click();

    await soft(entriesOf(popup)).toHaveCount(1);
    for (const name of kept) await soft(popup.getByRole('button', { name, exact: true })).toBeVisible();
    for (const name of gone) await soft(popup.getByRole('button', { name, exact: true })).toHaveCount(0);
    await soft.poll(async () => kept.includes((await focusedControlIn(popup)) ?? '')).toBe(true);
  });
}

const TREE_DISMISSALS: Array<{ press: string; left: number }> = [
  { press: FOR_REPO, left: 1 },
  { press: UNTIL_UPDATE, left: 2 },
];

for (const { press, left } of TREE_DISMISSALS) {
  test(`${press} leaves the repository's working tree byte-for-byte unchanged (AC15)`, { tag: '@ownapp' }, async () => {
    const repo = repoIn({ ignored: false, capabilities: 'absent' });
    git.writeRepoFile(repo, 'src/app.txt', 'tracked content\n');
    const page = await launchIn(repo);
    const popup = popupFor(page, repo);
    await expect(entriesOf(popup)).toHaveCount(3);
    const before = snapshotTree(repo);

    await popup.getByRole('button', { name: press }).click();
    await expect.soft(entriesOf(popup)).toHaveCount(left);

    expect(snapshotTree(repo)).toEqual(before);
  });
}

test("with the examples installed, a popup listing only repository entries offers no Don't show again until the app updates (AC12)", { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: false, capabilities: 'absent' });
  await installExamplesThroughApp();
  const page = await launchIn(repo);
  const popup = popupFor(page, repo);
  await expect(entriesOf(popup)).toHaveCount(2);

  await expect(popup.getByRole('button', { name: UNTIL_UPDATE })).toHaveCount(0);
});

test("a popup listing only the examples entry offers no Don't show again for this repo (AC12)", { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: true, capabilities: 'valid' });
  const page = await launchIn(repo);
  const popup = popupFor(page, repo);
  await expect(entriesOf(popup)).toHaveCount(1);

  await expect(popup.getByRole('button', { name: FOR_REPO })).toHaveCount(0);
});

test("a repository dismissal for a repository the app has not entered is refused, and that repository's popup still opens on entry", { tag: '@ownapp' }, async () => {
  const start = repoIn({ ignored: true, capabilities: 'valid' });
  const probe = repoIn({ ignored: false, capabilities: 'absent' });
  await installExamplesThroughApp();
  const page = await launchIn(start);
  const seen = await recordDialogs(page);

  const refused = await page.evaluate((repoKey) => window.setup.dismiss({ kind: 'repo', repoKey }), probe);
  await shellCd(page, probe, 'probe');

  expect.soft(refused).toMatchObject({ ok: false });
  await expect.poll(namedAmong(seen, [start, probe])).toEqual([probe]);
  await expect(entriesOf(popupFor(page, probe))).toHaveCount(2);
});

const pickerHost = (page: Page): Locator => page.locator('#app .rail:has(#flow-strip) #flow-picker');
const flowControl = (page: Page): Locator => page.locator('#flow-strip .flow-control');
const flowError = (page: Page): Locator => page.locator('#flow-strip .flow-error');

/** A fake agent on the launched app's PATH that logs every line it is handed and answers none, keyed to a step
 *  no shipped flow has, so no shipped step id is typed in here. Returns its injected-line log for `repo`. */
function seedLoggingAgent(repo: string): { env: Record<string, string | undefined>; injectedLog: () => string } {
  const binDir = mkdtempSync(join(tmpdir(), 'setup-check-agent-'));
  scratch.push(binDir);
  seedFakeAgentV2(binDir, { stepId: 'no-shipped-step', artifactRel: '.agent-terminal/loop/artifacts/unused.md', work: 'noop', logInjected: true });
  const log = join(repo, '.agent-terminal', 'injected-log');
  return {
    env: { ...machine.env, APP_SETUP_CHECK: 'off', PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
    injectedLog: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
  };
}

test('after Install examples through the app, the flow picker lists the repo-setup flow (AC24)', { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: true, capabilities: 'valid' });
  await installExamplesThroughApp();
  const page = await launchIn(repo, { ...machine.env, APP_SETUP_CHECK: 'off' });

  await pickerHost(page).getByRole('button', { name: /flow/i }).click();

  await expect(pickerHost(page).getByRole('option', { name: new RegExp(REPO_SETUP_FLOW_ID) })).toBeVisible();
});

test('the installed repo-setup flow, once selected, starts with no flow-load error and its work turn begins (AC24)', { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: false, capabilities: 'absent' });
  await installExamplesThroughApp();
  writeActiveFlow(repo, REPO_SETUP_FLOW_ID);
  const agent = seedLoggingAgent(repo);
  const page = await launchIn(repo, agent.env);
  await page.locator('.xterm-screen').click();
  await page.keyboard.type('fake-agent', { delay: 20 });
  await page.keyboard.press('Enter');

  await expect.soft(flowError(page)).toHaveCount(0);
  await expect(flowControl(page)).toHaveText('Start');
  await flowControl(page).click();

  await expect.poll(agent.injectedLog, { timeout: 40_000 }).toContain('turn-done:work-');
  await expect(flowError(page)).toHaveCount(0);
});
