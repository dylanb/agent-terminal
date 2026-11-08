/// <reference lib="dom" />
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellQuote } from '../../src/shared/shellQuote';
import { REPO_SETUP_FLOW_ID } from '../../src/shared/setupCheck';
import { readActiveFlow, writeActiveFlow } from '../../src/main/activeFlowPointer';
import { userConfigLoopsV2Dir } from '../../src/main/userConfig';
import { WINDOW_TIMEOUT_MS } from '../helpers/e2eBudget';
import { createGitRepoFixture, type GitRepoFixture } from '../helpers/gitRepo';
import { writeRepoConditions, type RepoConditionsFixture } from '../helpers/setupRepoConditions';
import { snapshotTree } from '../helpers/treeSnapshot';
import { createWorktreeFixture, type WorktreeFixture } from '../helpers/worktreeFixture';
import { electron } from './registeredElectron';
import { FAKE_AGENT_READY, chainBudget, seedFakeAgentSteps, seedFakeAgentV2, seedFakeGhGit, writeCatalogEntry } from './fakeTools';
import { createSetupCheckMachine, failingCheckIgnoreGit, type SetupCheckMachine } from './setupCheckEnv';

// The setup check (#290): while the terminal's directory fails a condition, the top bar shows a setup needed
// button, and pressing it opens the popup listing each failing condition. Nothing opens on its own.

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
const setupNeeded = (page: Page): Locator => page.getByRole('button', { name: 'setup needed', exact: true });

/** Presses the setup needed button and returns the popup it opens for `repoKey`. */
async function openSetup(page: Page, repoKey: string): Promise<Locator> {
  await setupNeeded(page).click();
  const popup = popupFor(page, repoKey);
  await expect(popup).toBeVisible();
  return popup;
}
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
  test(`starting in a repository that ${title} shows setup needed, which opens the popup listing it beside the examples entry`, { tag: '@ownapp' }, async () => {
    const repo = repoIn(conditions);
    const page = await launchIn(repo);

    await expect(entriesOf(await openSetup(page, repo))).toHaveCount(2);
  });
}

test('a failing repository opens no popup on its own, at startup or on cd, and the terminal keeps taking keyboard input', { tag: '@ownapp' }, async () => {
  const failing = repoIn({ ignored: false, capabilities: 'absent' });
  const other = repoIn({ ignored: true, capabilities: 'absent' });
  const page = await launchIn(failing);
  const seen = await recordDialogs(page);
  await expect(setupNeeded(page)).toBeVisible();

  await cdInto(page, other);
  await page.keyboard.type("printf '%s-%s\\n' typed reached", { delay: 20 });
  await page.keyboard.press('Enter');

  await expect(page.locator('.xterm-rows')).toContainText('typed-reached');
  await expect(setupNeeded(page)).toBeVisible();
  expect(await seen()).toEqual([]);
});

test("starting in a repository where git cannot answer the ignore question lists that the app couldn't check it (AC6)", { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: true, capabilities: 'valid' });
  const failingGit = failingCheckIgnoreGit();
  cleanups.push(() => failingGit.dispose());
  const page = await launchIn(repo, { ...machine.env, PATH: `${failingGit.binDir}${delimiter}${process.env.PATH ?? ''}` });

  await expect(entriesOf(await openSetup(page, repo))).toHaveCount(2);
});

test('a repository failing both repository conditions lists each with its own message, beside the examples entry', { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: false, capabilities: 'absent' });
  const page = await launchIn(repo);
  const entries = entriesOf(await openSetup(page, repo));

  await expect
    .poll(async () => new Set((await entries.allTextContents()).map((t) => t.trim()).filter(Boolean)).size)
    .toBe(3);
});

test('setup needed follows the terminal: absent where everything passes, shown in a failing repository, gone again on the way back (AC8, AC9)', { tag: '@ownapp' }, async () => {
  const passing = repoIn({ ignored: true, capabilities: 'valid' });
  const failing = repoIn({ ignored: false, capabilities: 'absent' });
  worktrees.writeFlowHome(passing, { name: 'passing-repo-flow', stepIds: ['passing-repo-step'] });
  await installExamplesThroughApp();
  const page = await launchIn(passing);
  await expect(page.locator('#flow-strip')).toContainText('passing-repo-step');
  const soft = expect.configure({ soft: true });
  await soft(setupNeeded(page)).toHaveCount(0);

  await cdInto(page, failing);
  await soft(setupNeeded(page)).toBeVisible();
  await soft(entriesOf(await openSetup(page, failing))).toHaveCount(2);
  await page.keyboard.press('Escape');
  await cdInto(page, passing);

  await expect(setupNeeded(page)).toHaveCount(0);
});

const focusIsInside = (popup: Locator): Promise<boolean> => popup.evaluate((el) => el.contains(document.activeElement));
const focusIsOnSetupNeeded = (page: Page): Promise<boolean> =>
  page.evaluate(() => document.activeElement instanceof HTMLButtonElement && document.activeElement.textContent === 'setup needed');

test('the popup is announced as a modal dialog, keeps Tab inside, and Escape returns focus to setup needed (AC11)', { tag: '@ownapp' }, async () => {
  const failing = repoIn({ ignored: false, capabilities: 'absent' });
  await installExamplesThroughApp();
  const page = await launchIn(failing);
  const popup = await openSetup(page, failing);
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
  await soft.poll(() => focusIsOnSetupNeeded(page)).toBe(true);
});

test('Close dismisses nothing: a restart with the same failures lists them again (AC16)', { tag: '@ownapp' }, async () => {
  const failing = repoIn({ ignored: false, capabilities: 'absent' });
  let page = await launchIn(failing);
  const popup = await openSetup(page, failing);
  await expect.soft(entriesOf(popup)).toHaveCount(3);

  await popup.getByRole('button', { name: 'Close' }).click();
  await expect.soft(popup).toBeHidden();
  await app?.close();
  page = await launchIn(failing);

  await expect(entriesOf(await openSetup(page, failing))).toHaveCount(3);
});

test("closing the popup after setup needed left the page lands focus in the app, not on the page body", { tag: '@ownapp' }, async () => {
  const failing = repoIn({ ignored: false, capabilities: 'absent' });
  await installExamplesThroughApp();
  const page = await launchIn(failing);
  const popup = await openSetup(page, failing);
  await page.evaluate(() => document.getElementById('setup-needed')?.replaceChildren());

  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();

  await expect.poll(() => page.evaluate(() => document.activeElement !== null && document.activeElement !== document.body)).toBe(true);
});

const INSTALL = 'Install/update examples';

test('on a fresh machine, a repository passing its own conditions lists the examples entry, with Install/update examples (AC7, AC12)', { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: true, capabilities: 'valid' });
  const page = await launchIn(repo);
  const popup = await openSetup(page, repo);

  await expect.soft(entriesOf(popup)).toHaveCount(1);
  await expect.soft(popup.getByRole('button', { name: INSTALL })).toBeVisible();
});

async function recordMaxModals(page: Page): Promise<() => Promise<number>> {
  await page.evaluate(() => {
    const state = { max: document.querySelectorAll('[aria-modal="true"]').length };
    new MutationObserver(() => {
      state.max = Math.max(state.max, document.querySelectorAll('[aria-modal="true"]').length);
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] });
    (window as unknown as { maxModals: { max: number } }).maxModals = state;
  });
  return () => page.evaluate(() => (window as unknown as { maxModals: { max: number } }).maxModals.max);
}

async function waitForExamplesInstalled(page: Page, repoKey: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((key) => window.setup.status(key).then((r) => r.ok && !r.entries.some((e) => e.condition === 'examples')), repoKey))
    .toBe(true);
}

test('Install/update examples installs from inside the popup: the Terminal view stays, the popup lists what still fails, offers Run setup loop, and focus stays in it (AC2, AC5, AC10)', { tag: '@ownapp' }, async () => {
  test.setTimeout(chainBudget(2));
  const repo = repoIn({ ignored: true, capabilities: 'absent' });
  const page = await launchIn(repo);
  const popup = await openSetup(page, repo);
  await expect.soft(entriesOf(popup)).toHaveCount(2);
  await hostStandInAgent(page);
  const maxModals = await recordMaxModals(page);
  const soft = expect.configure({ soft: true });

  await popup.getByRole('button', { name: INSTALL }).click();
  await waitForExamplesInstalled(page, repo);

  await soft(popup).toBeVisible();
  await soft(entriesOf(popup)).toHaveCount(1);
  await soft(installView(page)).toBeHidden();
  await soft(popup.getByRole('button', { name: INSTALL })).toHaveCount(0);
  await soft(popup.getByRole('button', { name: UNTIL_UPDATE })).toHaveCount(0);
  await soft(popup.getByRole('button', { name: RUN_SETUP })).toBeVisible();
  await soft.poll(() => focusIsInside(popup)).toBe(true);
  soft(await maxModals()).toBeLessThanOrEqual(1);
});

test('when an installed example differs, Install/update examples asks the replace question inside the same popup, and Install with nothing ticked keeps the file and the popup listing (AC3, AC10)', { tag: '@ownapp' }, async () => {
  test.setTimeout(chainBudget(2));
  await installExamplesThroughApp();
  const command = join(machine.claudeConfigDir, 'commands', 'groom-ticket.md');
  const custom = '# my own groom-ticket\n';
  writeFileSync(command, custom);
  const repo = repoIn({ ignored: false, capabilities: 'absent' });
  const page = await launchIn(repo);
  const popup = await openSetup(page, repo);
  await expect.soft(entriesOf(popup)).toHaveCount(3);
  const maxModals = await recordMaxModals(page);
  const soft = expect.configure({ soft: true });

  await popup.getByRole('button', { name: INSTALL }).click();
  const question = page.getByRole('dialog');
  await soft(question.getByRole('checkbox').first()).toBeVisible();
  await soft(question.getByRole('button', { name: 'Install', exact: true })).toBeVisible();
  await soft(question.getByRole('button', { name: 'Back to the list' })).toBeVisible();
  await soft(installView(page)).toBeHidden();
  await soft(page.locator('[aria-modal="true"]')).toHaveCount(1);
  await question.getByRole('button', { name: 'Install', exact: true }).click();

  await soft(popupFor(page, repo)).toBeVisible();
  await soft(entriesOf(popupFor(page, repo))).toHaveCount(3);
  await soft(popup.getByRole('checkbox')).toHaveCount(0);
  soft(readFileSync(command, 'utf8')).toBe(custom);
  soft(await maxModals()).toBeLessThanOrEqual(1);
});

test('Install/update examples in a popup that lists only the examples entry closes it and setup needed goes, and a failing repository entered next shows it again (AC4, AC10)', { tag: '@ownapp' }, async () => {
  test.setTimeout(chainBudget(2));
  const repo = repoIn({ ignored: true, capabilities: 'valid' });
  const failing = repoIn({ ignored: false, capabilities: 'absent' });
  const page = await launchIn(repo);
  const popup = await openSetup(page, repo);
  await expect.soft(entriesOf(popup)).toHaveCount(1);
  const maxModals = await recordMaxModals(page);
  const soft = expect.configure({ soft: true });

  await popup.getByRole('button', { name: INSTALL }).click();
  await waitForExamplesInstalled(page, repo);

  await soft(installView(page)).toBeHidden();
  await soft(page.locator('[aria-modal="true"]')).toHaveCount(0);
  await soft(setupNeeded(page)).toHaveCount(0);
  await shellCd(page, failing, 'failing');
  await soft(entriesOf(await openSetup(page, failing))).toHaveCount(2);
  soft(await maxModals()).toBeLessThanOrEqual(1);
});

test('starting outside a git repository on a fresh machine lists only the examples entry (AC9)', { tag: '@ownapp' }, async () => {
  const start = realpathSync(worktrees.makeFirstRunWorktree('setup-check-plain-examples'));
  writeRepoConditions(start, { ignored: false, capabilities: 'malformed' });
  const page = await launchIn(start);

  await setupNeeded(page).click();
  await expect.soft(entriesOf(page.getByRole('dialog'))).toHaveCount(1);
  const reply = await page.evaluate((dir) => window.setup.status(dir), start);
  expect.soft(reply).toMatchObject({ ok: true, isRepository: false, entries: [{ condition: 'examples', failure: 'stale' }] });
});

test('with the examples installed, a popup listing only repository entries offers no Install/update examples (AC12)', { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: false, capabilities: 'absent' });
  await installExamplesThroughApp();
  const page = await launchIn(repo);
  const popup = await openSetup(page, repo);
  await expect(entriesOf(popup)).toHaveCount(2);

  await expect(popup.getByRole('button', { name: INSTALL })).toHaveCount(0);
});

const FOR_REPO = "Don't show again for this repo";
const UNTIL_UPDATE = "Don't show again until the app updates";

/** Runs `cd` into `dir` in the terminal through the app's own input path, which reaches the shell whether or
 *  not a dialog holds focus, and waits until the shell has run it. */
async function shellCd(page: Page, dir: string, marker: string): Promise<void> {
  await page.evaluate((line) => window.term.input(line), `cd ${shellQuote(dir)} && printf '%s-%s\\n' at ${marker}\r`);
  await expect(page.locator('.xterm-rows')).toContainText(`at-${marker}`);
}

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
  const popup = await openSetup(page, dismissed);
  await expect(entriesOf(popup)).toHaveCount(2);

  await popup.getByRole('button', { name: FOR_REPO }).click();
  await expect.soft(popup).toBeHidden();
  await app?.close();
  page = await launchIn(dismissed);
  await expect.poll(() => page.evaluate((repoKey) => window.setup.status(repoKey).then((r) => r.ok && r.entries.length), dismissed)).toBe(0);
  await expect.soft(setupNeeded(page)).toHaveCount(0);
  await shellCd(page, other, 'other');

  await expect.soft(entriesOf(await openSetup(page, other))).toHaveCount(2);
});

test("Don't show again until the app updates silences the examples entry after a same-version restart (AC14)", { tag: '@ownapp' }, async () => {
  const passing = repoIn({ ignored: true, capabilities: 'valid' });
  const probe = repoIn({ ignored: false, capabilities: 'absent' });
  let page = await launchIn(passing);
  const popup = await openSetup(page, passing);
  await expect(entriesOf(popup)).toHaveCount(1);
  const running = await app!.evaluate(({ app: electronApp }) => electronApp.getVersion());
  const reply = await page.evaluate((repoKey) => window.setup.status(repoKey), passing);
  expect.soft(reply).toMatchObject({ ok: true, appVersion: running });

  await popup.getByRole('button', { name: UNTIL_UPDATE }).click();
  await expect.soft(popup).toBeHidden();
  await app?.close();
  page = await launchIn(passing);
  await expect.poll(() => page.evaluate((repoKey) => window.setup.status(repoKey).then((r) => r.ok && r.entries.length), passing)).toBe(0);
  await expect.soft(setupNeeded(page)).toHaveCount(0);
  await shellCd(page, probe, 'probe');

  await expect.soft(entriesOf(await openSetup(page, probe))).toHaveCount(2);
});

const MIXED_DISMISSALS: Array<{ press: string; kept: string[]; gone: string[] }> = [
  { press: FOR_REPO, kept: [INSTALL, UNTIL_UPDATE, 'Close'], gone: [FOR_REPO] },
  { press: UNTIL_UPDATE, kept: [FOR_REPO, 'Close'], gone: [INSTALL, UNTIL_UPDATE] },
];

for (const { press, kept, gone } of MIXED_DISMISSALS) {
  test(`in a popup listing both kinds, ${press} leaves the other kind listed with its controls, and focus on one of them (AC14)`, { tag: '@ownapp' }, async () => {
    const repo = repoIn({ ignored: true, capabilities: 'absent' });
    const page = await launchIn(repo);
    const popup = await openSetup(page, repo);
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
    const popup = await openSetup(page, repo);
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
  const popup = await openSetup(page, repo);
  await expect(entriesOf(popup)).toHaveCount(2);

  await expect(popup.getByRole('button', { name: UNTIL_UPDATE })).toHaveCount(0);
});

test("a popup listing only the examples entry offers no Don't show again for this repo (AC12)", { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: true, capabilities: 'valid' });
  const page = await launchIn(repo);
  const popup = await openSetup(page, repo);
  await expect(entriesOf(popup)).toHaveCount(1);

  await expect(popup.getByRole('button', { name: FOR_REPO })).toHaveCount(0);
});

test("a repository dismissal for a repository the app has not entered is refused, and setup needed still shows on entry", { tag: '@ownapp' }, async () => {
  const start = repoIn({ ignored: true, capabilities: 'valid' });
  const probe = repoIn({ ignored: false, capabilities: 'absent' });
  await installExamplesThroughApp();
  const page = await launchIn(start);

  const refused = await page.evaluate((repoKey) => window.setup.dismiss({ kind: 'repo', repoKey }), probe);
  await shellCd(page, probe, 'probe');

  expect.soft(refused).toMatchObject({ ok: false });
  await expect(entriesOf(await openSetup(page, probe))).toHaveCount(2);
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
  await expect(page.locator('.xterm-rows')).toContainText(FAKE_AGENT_READY);

  await expect.soft(flowError(page)).toHaveCount(0);
  await expect(flowControl(page)).toHaveText('Start');
  await flowControl(page).click();

  await expect.poll(agent.injectedLog, { timeout: 40_000 }).toContain('turn-done:work-');
  await expect(flowError(page)).toHaveCount(0);
});

const RUN_SETUP = 'Run setup loop';
const FX_SETUP = 'fx-setup';
const FX_PUBLISH = 'fx-publish';

/** A two-step `repo-setup` flow of this test's own, both steps human-gated loops with one work turn each and no
 *  reviewers, so the e2e reads none of the shipped flow's configured values. */
const FIXTURE_SETUP_FLOW = [
  `name: ${REPO_SETUP_FLOW_ID}`,
  'steps:',
  ...[FX_SETUP, FX_PUBLISH].flatMap((step) => [
    `  - id: ${step}`,
    '    kind: loop',
    '    gate_authority: human',
    `    loop: ${step}-loop`,
    '    loop_namespace: app',
  ]),
  '',
].join('\n');

/** Installs `flowYaml` as the `repo-setup` entry of this machine's global catalog, and the fixture's two loops in
 *  its Claude config. Each loop's work artifact is named after its step, the id the fake agent's marker carries. */
function installFixtureSetupFlow(flowYaml = FIXTURE_SETUP_FLOW): void {
  writeCatalogEntry(machine.appHome, REPO_SETUP_FLOW_ID, flowYaml);
  const loops = userConfigLoopsV2Dir(machine.claudeConfigDir);
  if (loops === null) throw new Error(`no loops-v2 directory under ${machine.claudeConfigDir}`);
  for (const step of [FX_SETUP, FX_PUBLISH]) {
    const dir = join(loops, `${step}-loop`);
    mkdirSync(join(dir, 'prompts'), { recursive: true });
    writeFileSync(join(dir, 'prompts', 'work.md'), `Do the ${step} work.\n`);
    writeFileSync(
      join(dir, `${step}-loop.yaml`),
      [
        'version: v2', `name: ${step}-loop`, 'work:', '  recipe: prompts/work.md', `  artifact: ${step}`, 'reviewers: []', 'boundaries: []',
        'report:', '  sections: [summary]', 'gate:', '  - option: approve', '  - option: redo', 'outputs:', `  - id: ${step}`, `    path: ${step}.md`, '',
      ].join('\n'),
    );
  }
}

/** A fake agent for the fixture flow that logs every line it is handed. Its setup turn completes; its publish turn
 *  commits and opens a PR through the fake git and gh, whose calls are logged. */
function seedFixtureSetupAgent(repo: string): { env: Record<string, string | undefined>; injectedLog: () => string; toolLog: () => string } {
  const binDir = mkdtempSync(join(tmpdir(), 'setup-check-fx-agent-'));
  scratch.push(binDir);
  const tools = seedFakeGhGit('setup-check-fx-tools-');
  scratch.push(tools.binDir);
  seedFakeAgentSteps(binDir, {
    [FX_SETUP]: { artifactRel: `.agent-terminal/loop/artifacts/${FX_SETUP}.md`, work: 'complete', logInjected: true },
    [FX_PUBLISH]: {
      artifactRel: `.agent-terminal/loop/artifacts/${FX_PUBLISH}.md`,
      work: 'complete',
      extraShell: { work: ['git commit --allow-empty -m publish; git push origin HEAD; gh pr create --draft --title publish --body publish'] },
    },
  });
  const log = join(repo, '.agent-terminal', 'injected-log');
  return {
    env: {
      ...machine.env,
      FAKE_GHGIT_LOG: tools.logFile,
      PATH: `${binDir}${delimiter}${tools.binDir}${delimiter}${process.env.PATH ?? ''}`,
    },
    injectedLog: () => (existsSync(log) ? readFileSync(log, 'utf8') : ''),
    toolLog: () => (existsSync(tools.logFile) ? readFileSync(tools.logFile, 'utf8') : ''),
  };
}

/** Runs the fake agent in the terminal, through the app's own input path, and waits until it is hosted. */
async function hostFakeAgent(page: Page): Promise<void> {
  await page.evaluate((line) => window.term.input(line), 'fake-agent\r');
  await expect(page.locator('.xterm-rows')).toContainText(FAKE_AGENT_READY);
}

/** Runs a listed agent name that stays in the foreground and never reads a turn, for a test whose agent is
 *  never handed one. */
async function hostStandInAgent(page: Page): Promise<void> {
  await page.evaluate((line) => window.term.input(line), "alias fake-agent='sleep 600'\r");
  await page.evaluate((line) => window.term.input(line), 'fake-agent\r');
}

const activeStation = (page: Page): Locator => page.locator('#flow-strip .stn.active .nm');
const loopTone = (page: Page): Locator => page.locator('#flow-strip .loopstat .spill');

/** What the page shows of the setup run in `repo`, read once: whether its popup is open, whether setup needed is
 *  shown, whether the fixture's first step's work prompt has reached the agent, the strip's active station, whether
 *  that station's loop has settled (its turn done, the step held at its human gate), and how many dialogs are open. */
async function setupRunSeen(page: Page, repo: string, injectedLog: () => string) {
  const tone = loopTone(page);
  return {
    popupOpen: await popupFor(page, repo).count(),
    setupNeeded: await setupNeeded(page).count(),
    firstTurnRan: injectedLog().includes(`turn-done:work-${FX_SETUP}`),
    activeStation: await activeStation(page).allTextContents(),
    settledAtGate: (await tone.count()) === 1 && /\bsettle\b/.test((await tone.getAttribute('class')) ?? ''),
    dialogsOpen: await page.getByRole('dialog').count(),
  };
}

/** The examples entry is still listed, so setup needed stays for it. */
const AT_FIRST_GATE = {
  popupOpen: 0,
  setupNeeded: 1,
  firstTurnRan: true,
  activeStation: [FX_SETUP],
  settledAtGate: true,
  dialogsOpen: 0,
};

test("Run setup loop starts the installed repo-setup flow in the popup's repository with no ticket prompt, and its first step reaches its gate (AC18)", { tag: '@ownapp' }, async () => {
  test.setTimeout(chainBudget(2));
  const repo = repoIn({ ignored: false, capabilities: 'absent' });
  installFixtureSetupFlow();
  const agent = seedFixtureSetupAgent(repo);
  const page = await launchIn(repo, agent.env);
  const popup = await openSetup(page, repo);
  await hostFakeAgent(page);
  const maxModals = await recordMaxModals(page);

  await popup.getByRole('button', { name: RUN_SETUP }).click();

  await expect.poll(() => setupRunSeen(page, repo, agent.injectedLog), { timeout: 40_000 }).toEqual(AT_FIRST_GATE);
  expect.soft(await maxModals()).toBeLessThanOrEqual(1);
});

test('with no agent running the popup withholds Run setup loop and says to start one; once the agent starts it offers it, and the setup flow runs', { tag: '@ownapp' }, async () => {
  test.setTimeout(chainBudget(2));
  const repo = repoIn({ ignored: false, capabilities: 'absent' });
  installFixtureSetupFlow();
  const agent = seedFixtureSetupAgent(repo);
  const page = await launchIn(repo, agent.env);
  let popup = await openSetup(page, repo);
  await expect(popup.getByRole('button', { name: RUN_SETUP })).toHaveCount(0);
  await popup.getByRole('button', { name: 'Close' }).click();
  await expect(popup).toHaveCount(0);
  await page.locator('.xterm-screen').click();
  await page.keyboard.type('fake-agent', { delay: 20 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText(FAKE_AGENT_READY);
  await expect.soft(popup).toHaveCount(0);
  const maxModals = await recordMaxModals(page);

  popup = await openSetup(page, repo);
  await popup.getByRole('button', { name: RUN_SETUP }).click();

  await expect.poll(() => setupRunSeen(page, repo, agent.injectedLog), { timeout: 40_000 }).toEqual(AT_FIRST_GATE);
  expect.soft(await maxModals()).toBeLessThanOrEqual(1);
});

test("at the setup flow's first gate nothing is committed, pushed or filed, and the next step's turn has not run (AC20)", { tag: '@ownapp' }, async () => {
  test.setTimeout(chainBudget(2));
  const repo = repoIn({ ignored: false, capabilities: 'absent' });
  installFixtureSetupFlow();
  const agent = seedFixtureSetupAgent(repo);
  const page = await launchIn(repo, agent.env);
  const popup = await openSetup(page, repo);
  await hostFakeAgent(page);
  const maxModals = await recordMaxModals(page);
  const soft = expect.configure({ soft: true });

  await popup.getByRole('button', { name: RUN_SETUP }).click();

  await soft.poll(() => setupRunSeen(page, repo, agent.injectedLog), { timeout: 40_000 }).toEqual(AT_FIRST_GATE);
  soft(await maxModals()).toBeLessThanOrEqual(1);
  soft(agent.injectedLog()).not.toContain(`turn-done:work-${FX_PUBLISH}`);
  soft(agent.toolLog().split('\n').filter((line) => /^(git (commit|push)|gh (pr|issue) create)\b/.test(line))).toEqual([]);
});

const BEGUN_STATES = ['in_progress', 'done'] as const;

for (const status of BEGUN_STATES) {
  test(`with the repository's run ${status === 'done' ? 'done and not reset' : 'in progress'}, Run setup loop closes the popup, shows the refusal in an error dialog, and changes nothing about the run (AC19)`, { tag: '@ownapp' }, async () => {
    const repo = repoIn({ ignored: false, capabilities: 'absent' });
    installFixtureSetupFlow();
    writeCatalogEntry(machine.appHome, 'operator-flow', 'name: operator-flow\nsteps:\n  - id: operator-step\n    kind: manual\n');
    writeActiveFlow(repo, 'operator-flow');
    git.writeRepoFile(repo, '.agent-terminal/flow-state.yaml', `step: operator-step\nstatus: ${status}\n`);
    const page = await launchIn(repo);
    const popup = await openSetup(page, repo);
    await hostStandInAgent(page);
    const before = snapshotTree(repo);
    const maxModals = await recordMaxModals(page);
    const soft = expect.configure({ soft: true });

    await popup.getByRole('button', { name: RUN_SETUP }).click();

    await soft(popup).toHaveCount(0);
    const gate = await page.evaluate(({ repoKey, id }) => window.flow.setActiveFlow(repoKey, id), { repoKey: repo, id: REPO_SETUP_FLOW_ID });
    soft(gate, "the selection gate still refuses the repository's begun run").toMatchObject({ ok: false });
    await soft(page.getByRole('alertdialog').filter({ hasText: gate.ok ? '' : gate.reason })).toBeVisible();
    await soft(page.getByRole('dialog')).toHaveCount(0);
    await soft(setupNeeded(page)).toBeVisible();
    soft(await maxModals()).toBeLessThanOrEqual(1);
    expect(snapshotTree(repo)).toEqual(before);
  });
}

test('a repo-setup flow that fails to load is selected, the popup closes, and the flow strip shows its load error', { tag: '@ownapp' }, async () => {
  const repo = repoIn({ ignored: false, capabilities: 'absent' });
  installFixtureSetupFlow(`name: ${REPO_SETUP_FLOW_ID}\nsteps: not-a-list\n`);
  const page = await launchIn(repo);
  const popup = await openSetup(page, repo);
  await hostStandInAgent(page);
  const errorBefore = await flowError(page).allTextContents();
  const soft = expect.configure({ soft: true });

  await popup.getByRole('button', { name: RUN_SETUP }).click();

  await soft.poll(async () => ({
    popupOpen: await popupFor(page, repo).count(),
    newLoadError: await flowError(page).allTextContents().then((now) => now.length === 1 && now[0] !== errorBefore[0]),
  })).toEqual({ popupOpen: 0, newLoadError: true });
  soft(readActiveFlow(repo)).toEqual({ kind: 'value', id: REPO_SETUP_FLOW_ID });
});

const HIDDEN_RUN_SETUP: Array<{ when: string; conditions: RepoConditionsFixture; entries: number; installed: 'fixture' | 'none' | 'repository too' }> = [
  { when: 'lists only the examples entry', conditions: { ignored: true, capabilities: 'valid' }, entries: 1, installed: 'fixture' },
  { when: 'lists only a rejected loop-capabilities.yaml beside the examples entry', conditions: { ignored: true, capabilities: 'malformed' }, entries: 2, installed: 'fixture' },
  { when: 'has no repo-setup flow installed', conditions: { ignored: false, capabilities: 'valid' }, entries: 2, installed: 'none' },
  { when: 'carries its own repo-setup flow beside the installed one', conditions: { ignored: false, capabilities: 'valid' }, entries: 2, installed: 'repository too' },
];

for (const { when, conditions, entries, installed } of HIDDEN_RUN_SETUP) {
  test(`a popup for a repository that ${when} offers no Run setup loop (AC12, AC18)`, { tag: '@ownapp' }, async () => {
    const repo = repoIn(conditions);
    if (installed !== 'none') installFixtureSetupFlow();
    if (installed === 'repository too') writeCatalogEntry(repo, REPO_SETUP_FLOW_ID, FIXTURE_SETUP_FLOW);
    const page = await launchIn(repo);
    const popup = await openSetup(page, repo);
    await expect(entriesOf(popup)).toHaveCount(entries);
    await hostStandInAgent(page);

    await expect(popup.getByRole('button', { name: RUN_SETUP })).toHaveCount(0);
  });
}

test('on a fresh machine, Install/update examples then a relaunch offers Run setup loop, which starts the shipped repo-setup flow with no ticket prompt', { tag: '@ownapp' }, async () => {
  test.setTimeout(chainBudget(2));
  const repo = repoIn({ ignored: false, capabilities: 'absent' });
  const agent = seedLoggingAgent(repo);
  const env = { ...agent.env, APP_SETUP_CHECK: 'on' };
  let page = await launchIn(repo, env);
  const first = await openSetup(page, repo);
  await first.getByRole('button', { name: INSTALL }).click();
  await waitForExamplesInstalled(page, repo);
  await expect.soft(first).toBeVisible();
  await expect.soft(first.getByRole('button', { name: INSTALL })).toHaveCount(0);
  await app?.close();
  page = await launchIn(repo, env);
  const popup = await openSetup(page, repo);
  const reply = await page.evaluate((repoKey) => window.setup.status(repoKey), repo);
  expect.soft(reply).toMatchObject({ ok: true, setupFlowInstalled: true });
  expect.soft(reply.ok && reply.entries.some((entry) => entry.condition === 'examples')).toBe(false);
  await hostFakeAgent(page);
  const maxModals = await recordMaxModals(page);

  await popup.getByRole('button', { name: RUN_SETUP }).click();

  await expect.poll(agent.injectedLog, { timeout: 40_000 }).toContain('turn-done:work-');
  expect.soft(await maxModals()).toBeLessThanOrEqual(1);
  await expect.soft(page.getByRole('dialog')).toHaveCount(0);
  await expect.soft(flowError(page)).toHaveCount(0);
  expect(readActiveFlow(repo)).toEqual({ kind: 'value', id: REPO_SETUP_FLOW_ID });
});
