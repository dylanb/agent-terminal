import { expect, test, type Locator, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createControllerDesktopHarness } from './controllerDesktop';
import { seedTrustedFlow } from './autoGateHarness';
import { STATUS_BUDGET_MS } from './controllerStatusObservation';
import { cardHeaderElementLocator, cardHeaderLocator, cardLocator, directoryPattern, headerRemainder } from '../helpers/controllerCards';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
const STATUS_WORD_SOURCE = 'Working|Idle|Unassigned|Activity unavailable|Completed|Needs a human|Flow error|Loop error|Disconnected|Loading|Status unknown';

type Harness = Awaited<ReturnType<typeof createControllerDesktopHarness>>;

const statusTitle = (terminal: Page) => terminal.locator('#status-bar [data-sb-title]');

async function nameWork(terminal: Page, title: string): Promise<void> {
  await statusTitle(terminal).click();
  const editor = terminal.locator('#status-bar input[data-sb-title-edit]');
  await editor.fill(title);
  await editor.press('Enter');
}

async function typeInTerminal(terminal: Page, command: string): Promise<void> {
  await terminal.locator('.xterm-screen').click();
  await expect.poll(() => terminal.evaluate(() => document.activeElement?.tagName)).toBe('TEXTAREA');
  await terminal.keyboard.type(command);
  await terminal.keyboard.press('Enter');
}

async function launchPair(h: Harness, directory: string, terminalEnv: Record<string, string> = {}) {
  const controller = await h.launch(controllerTarget, h.fixture.nonGit);
  const terminal = await h.launch(terminalTarget, directory, { env: terminalEnv });
  const card = cardLocator(controller.page, directory);
  const toggle = cardHeaderLocator(card, directory);
  const header = cardHeaderElementLocator<Locator>(card);
  const setExpanded = async (expanded: boolean): Promise<void> => {
    await expect(toggle).toBeVisible({ timeout: STATUS_BUDGET_MS });
    if ((await toggle.getAttribute('aria-expanded')) !== String(expanded)) await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', String(expanded));
  };
  return { controller, terminal, card, header, setExpanded };
}

async function headerLeftover(header: Locator, directory: string, shown: readonly string[]): Promise<string> {
  const text = await header.innerText();
  return headerRemainder(text.replace(new RegExp(STATUS_WORD_SOURCE, 'g'), ' '), [directory, basename(directory), ...shown]);
}

test('the card header shows the title the user gave the work in the terminal status bar, collapsed and expanded', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const h = await createControllerDesktopHarness();
  const repo = h.fixture.repositories[0];
  const title = 'Reconcile the shadow parser';
  try {
    const { terminal, header, setExpanded } = await launchPair(h, repo);
    await nameWork(terminal.page, title);
    await expect(statusTitle(terminal.page)).toHaveText(title);
    await setExpanded(true);
    await expect.soft(header, 'expanded card header').toContainText(title, { timeout: STATUS_BUDGET_MS });
    await setExpanded(false);
    await expect.soft(header, 'collapsed card header').toContainText(title, { timeout: STATUS_BUDGET_MS });
  } finally {
    await h.dispose();
  }
});

test('the card header follows a ticket from #N to its GitHub title and back to the user title, matching the status bar', { tag: '@ownapp' }, async () => {
  test.setTimeout(240_000);
  const h = await createControllerDesktopHarness();
  const repo = h.fixture.repositories[0];
  const userTitle = 'Own name for the ticketed work';
  const allow = join(h.fixture.root, 'identity-gh-allow');
  try {
    mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
    seedTrustedFlow(h.fixture.home, repo, 'identity-ticket', 'name: identity-ticket\nsteps:\n  - id: implement\n    kind: manual\n    inputs:\n      - name: ticket\n        type: github-ticket\n');
    const stateFile = join(repo, '.agent-terminal', 'flow-state.yaml');
    writeFileSync(stateFile, `step: implement\nstatus: not_started\ninputs:\n  ticket: "219"\ntitle: ${userTitle}\n`);
    Object.assign(h.fixture.env, { PATH: `${join(h.fixture.root, 'bin')}:${process.env.PATH}`, IDENTITY_GH_ALLOW: allow });
    writeFileSync(join(h.fixture.root, 'bin', 'gh'), `#!/bin/sh
while [ ! -e "$IDENTITY_GH_ALLOW" ]; do sleep 0.02; done
printf '{"title":"GITHUB_TICKET_TITLE_%s","body":"PRIVATE BODY","url":"https://github.com/example/repo/issues/%s"}\\n' "$3" "$3"
`, { mode: 0o700 });
    const { terminal, header, setExpanded } = await launchPair(h, repo);
    const control = terminal.page.locator('#flow-strip .flow-control');
    await expect(statusTitle(terminal.page)).toHaveText(userTitle);
    await setExpanded(true);
    await expect.soft(header, 'user title before the ticket is in view').toContainText(userTitle, { timeout: STATUS_BUDGET_MS });

    await expect(control).toHaveText('Start');
    await control.click();
    await expect(statusTitle(terminal.page)).toHaveText('#219');
    await expect(header, 'ticket number while GitHub has not answered').toContainText('#219', { timeout: STATUS_BUDGET_MS });
    await expect.soft(header, 'ticket outranks the user title').not.toContainText(userTitle);

    writeFileSync(allow, 'release');
    await expect(statusTitle(terminal.page)).toHaveText('GITHUB_TICKET_TITLE_219', { timeout: STATUS_BUDGET_MS });
    await expect.soft(header, 'resolved GitHub title').toContainText('GITHUB_TICKET_TITLE_219', { timeout: STATUS_BUDGET_MS });
    await expect.soft(header, 'the number gives way to the title').not.toContainText('#219');
    await expect.soft(header, 'card text equals the status bar text').toContainText(await statusTitle(terminal.page).innerText());

    let inInputs = false;
    const withoutInputs = readFileSync(stateFile, 'utf8').split('\n').filter(line => {
      if (/^\S/.test(line)) inInputs = line.startsWith('inputs:');
      return !inInputs;
    }).join('\n');
    expect(withoutInputs).not.toMatch(/(?<!\d)219(?!\d)/);
    writeFileSync(stateFile, withoutInputs);
    await expect.soft(header, 'user title returns once the ref is gone').toContainText(userTitle, { timeout: STATUS_BUDGET_MS });
    await expect.soft(header, 'GitHub title is gone with the ref').not.toContainText('GITHUB_TICKET_TITLE_219');
  } finally {
    if (!existsSync(allow)) writeFileSync(allow, 'release during cleanup');
    await h.dispose();
  }
});

test('the card header follows a branch switch in the terminal\'s repository', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const h = await createControllerDesktopHarness();
  const repo = h.fixture.repositories[0];
  const switched = 'feature/switched-in-terminal';
  try {
    const { terminal, header, setExpanded } = await launchPair(h, repo, { APP_BRANCH_REFRESH_MS: '1000' });
    await setExpanded(true);
    await expect.soft(header, 'initial branch').toContainText('main', { timeout: STATUS_BUDGET_MS });
    await typeInTerminal(terminal.page, `git switch -c ${switched}`);
    await expect.soft(header, 'new branch').toContainText(switched, { timeout: STATUS_BUDGET_MS });
    await expect.soft(header, 'old branch is replaced').not.toContainText('main');
    await setExpanded(false);
    await expect.soft(header, 'new branch while collapsed').toContainText(switched, { timeout: STATUS_BUDGET_MS });
  } finally {
    await h.dispose();
  }
});

test('a terminal outside any git repository shows its title with no branch slot, and neither slot once the title is removed', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const h = await createControllerDesktopHarness();
  const directory = h.fixture.nonGit;
  const title = 'Spike outside version control';
  try {
    const { terminal, card, header, setExpanded } = await launchPair(h, directory);
    await nameWork(terminal.page, title);
    await expect(statusTitle(terminal.page)).toHaveText(title);
    await setExpanded(true);
    await expect.soft(header, 'title shown').toContainText(title, { timeout: STATUS_BUDGET_MS });
    expect.soft(await headerLeftover(header, directory, [title]), 'no branch slot beside the title').toBe('');

    await nameWork(terminal.page, '');
    await expect.soft(header, 'title removed').not.toContainText(title, { timeout: STATUS_BUDGET_MS });
    await expect(card).toBeVisible();
    expect.soft(await headerLeftover(header, directory, []), 'no title or branch slot, and no placeholder').toBe('');
    await expect.soft(header, 'repository name still shown').toContainText(basename(directory));
    await expect.soft(card, 'status still shown').toContainText(new RegExp(STATUS_WORD_SOURCE));
  } finally {
    await h.dispose();
  }
});

async function launchSiblings(h: Harness, directories: readonly string[]) {
  const controller = await h.launch(controllerTarget, h.fixture.nonGit);
  const terminals = [];
  for (const directory of directories) terminals.push(await h.launch(terminalTarget, directory));
  const cards = directories.map(directory => {
    const card = cardLocator(controller.page, directory);
    return { directory, card, toggle: cardHeaderLocator(card, directory), header: cardHeaderElementLocator<Locator>(card) };
  });
  for (const { toggle } of cards) {
    await expect(toggle).toBeVisible({ timeout: STATUS_BUDGET_MS });
    if ((await toggle.getAttribute('aria-expanded')) !== 'false') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  }
  return { controller, terminals, cards };
}

test('collapsed headers of two worktrees of one repository tell them apart by their own user titles, not by directory', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const h = await createControllerDesktopHarness();
  const titles = ['Alpha parser rewrite', 'Beta renderer polish'];
  try {
    const { terminals, cards } = await launchSiblings(h, h.fixture.worktrees);
    for (const [index, terminal] of terminals.entries()) {
      await nameWork(terminal.page, titles[index]);
      await expect(statusTitle(terminal.page)).toHaveText(titles[index]);
    }
    for (const [index, { directory, header }] of cards.entries()) {
      await expect.soft(header, `card ${index} shows its own title`).toContainText(titles[index], { timeout: STATUS_BUDGET_MS });
      await expect.soft(header, `card ${index} does not show its sibling's title`).not.toContainText(titles[1 - index]);
      await expect.soft(header, `card ${index} does not show its launch directory`).not.toContainText(directory);
    }
  } finally {
    await h.dispose();
  }
});

test('collapsed headers of two untitled worktrees tell them apart by their own branches, not by directory', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const h = await createControllerDesktopHarness();
  const branches = ['identity/alpha-branch', 'identity/beta-branch'];
  try {
    for (const [index, directory] of h.fixture.worktrees.entries()) {
      execFileSync('git', ['-C', directory, 'branch', '-m', branches[index]], { env: h.fixture.env, stdio: 'pipe' });
    }
    const { cards } = await launchSiblings(h, h.fixture.worktrees);
    for (const [index, { directory, header }] of cards.entries()) {
      await expect.soft(header, `card ${index} shows its own branch`).toContainText(branches[index], { timeout: STATUS_BUDGET_MS });
      await expect.soft(header, `card ${index} does not show its sibling's branch`).not.toContainText(branches[1 - index]);
      await expect.soft(header, `card ${index} does not show its launch directory`).not.toContainText(directory);
    }
  } finally {
    await h.dispose();
  }
});

test('the launch directory is not in the header text, collapsed or expanded, yet the disclosure toggle is still named by it', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const h = await createControllerDesktopHarness();
  const directory = h.fixture.repositories[0];
  try {
    const { card, header, setExpanded } = await launchPair(h, directory);
    for (const expanded of [false, true]) {
      await setExpanded(expanded);
      await expect.soft(card.getByRole('button', { name: directoryPattern(directory), expanded }), `toggle named by the directory (expanded=${expanded})`).toHaveCount(1);
      await expect.soft(header, `header text lacks the directory (expanded=${expanded})`).not.toContainText(directory);
    }
    await expect.soft(card, 'expanded card shows the directory').toContainText(directory);
  } finally {
    await h.dispose();
  }
});
