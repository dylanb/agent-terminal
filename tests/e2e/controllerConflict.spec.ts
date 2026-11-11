import { expect, test, type Page } from '@playwright/test';
import { once } from 'node:events';
import { connectWebSocket } from '../helpers/controllerWebSocket';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { CONTROLLER_PROTOCOL_MAJOR, encodeControllerMessage, parseControllerMessage } from '../../src/shared/controllerProtocol';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { shellQuote } from '../../src/shared/shellQuote';
import { exampleConsolidatorOutput } from '../../src/shared/consolidatorOutput';
import { bringForwardLocator, cardHeaderLocator, cardLocator, cardsLocator, dismissLocator, headerActivationLocator } from '../helpers/controllerCards';
import { connectedTerminals as connected } from './controllerSnapshot';
import { createControllerDesktopHarness } from './controllerDesktop';
import { autoGateFlowYaml, loopRoster, seedAutoGateRepo, seedTrustedFlow } from './autoGateHarness';
import { exampleConfigDir, seedFakeAgentV2, seedFakeGhGit } from './fakeTools';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
const contents = async (page: Page, directory: string) => (await cardLocator(page, directory).allTextContents()).join('\n');

async function command(page: Page, text: string, marker: string) {
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText(marker);
}

test('conflict connections retain real PTYs, restore original windows and reduce to a current survivor', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const h = await createControllerDesktopHarness();
  const bin = join(h.fixture.root, 'bin');
  seedFakeAgentV2(bin, { stepId: 'probe', artifactRel: '.agent-terminal/probe.json', work: 'complete', logInjected: true });
  h.fixture.env.PATH = `${bin}:${h.fixture.env.PATH}`;
  try {
    let controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const directory = h.fixture.worktrees[0];
    const a = await h.launch(terminalTarget, directory);
    const b = await h.launch(terminalTarget, directory);
    const other = await h.launch(terminalTarget, h.fixture.worktrees[1]);
    await expect.poll(() => connected(controller.page, directory).then(items => items.length)).toBe(2);
    await expect.soft(cardLocator(controller.page, directory)).toHaveCount(1);
    await expect.soft.poll(() => contents(controller.page, directory)).toContain('Duplicate directory');
    await expect.soft(cardsLocator(controller.page)).toHaveCount(2);
    await command(a.page, `CONFLICT_SESSION=original; cd ${shellQuote(h.fixture.nonGit)}; printf 'CWD_%s\\n' 'CHANGED'`, 'CWD_CHANGED');
    expect.soft((await connected(controller.page, directory)).length).toBe(2);
    await expect.soft(cardLocator(controller.page, h.fixture.nonGit)).toHaveCount(0);
    await b.page.locator('.xterm-screen').click();
    await b.page.keyboard.type('fake-agent');
    await b.page.keyboard.press('Enter');
    await b.page.keyboard.type('AGENT_RUNNING_PROBE');
    await b.page.keyboard.press('Enter');
    const agentInput = join(directory, '.agent-terminal/injected-log');
    await expect.poll(() => existsSync(agentInput) ? readFileSync(agentInput, 'utf8') : '').toContain('AGENT_RUNNING_PROBE');
    await b.page.keyboard.press('Control+c');
    await command(b.page, "printf 'AGENT_%s\\n' 'STOPPED'", 'AGENT_STOPPED');
    expect.soft((await connected(controller.page, directory)).length).toBe(2);
    await expect.soft.poll(() => contents(controller.page, directory)).toContain('Duplicate directory');
    const chosenHeader = cardHeaderLocator(cardLocator(controller.page, directory).first(), directory);
    await chosenHeader.click();
    await expect(chosenHeader).toHaveAttribute('aria-expanded', 'false');
    await controller.app.close();
    controller = await h.launch(controllerTarget, h.fixture.nonGit, { profile: controller.profile });
    await expect.poll(() => connected(controller.page, directory).then(items => items.length)).toBe(2);
    await expect.soft(cardHeaderLocator(cardLocator(controller.page, directory).first(), directory)).toHaveAttribute('aria-expanded', 'true');
    for (const [index, target] of [a, b, other].entries()) {
      await target.app.evaluate(({ BrowserWindow }, mode) => {
        const window = BrowserWindow.getAllWindows()[0];
        const probe = globalThis as typeof globalThis & { conflictFocus?: number };
        probe.conflictFocus = 0;
        window.on('focus', () => { probe.conflictFocus!++; });
        if (mode === 1) window.minimize(); else window.hide();
      }, index);
    }
    await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    const first = cardLocator(controller.page, directory).first();
    const header = cardHeaderLocator(first, directory);
    if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
    await expect(headerActivationLocator(first), 'header icon on the duplicate card').toBeVisible();
    await expect.soft(bringForwardLocator(first), 'one activation control on the card').toHaveCount(1);
    await headerActivationLocator(first).click();
    for (const target of [a, b]) {
      await expect.soft.poll(() => target.app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return { visible: window.isVisible(), minimized: window.isMinimized(), focused: ((globalThis as typeof globalThis & { conflictFocus?: number }).conflictFocus ?? 0) > 0 };
      })).toEqual({ visible: true, minimized: false, focused: true });
    }
    expect.soft(await other.app.evaluate(({ BrowserWindow }) => ({ visible: BrowserWindow.getAllWindows()[0].isVisible(), focused: (globalThis as typeof globalThis & { conflictFocus?: number }).conflictFocus }))).toEqual({ visible: false, focused: 0 });
    await a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await command(a.page, 'printf "SESSION_%s\\n" "$CONFLICT_SESSION"', 'SESSION_original');
    await b.app.close();
    await expect.poll(() => connected(controller.page, directory).then(items => items.length)).toBe(1);
    await expect.soft(cardLocator(controller.page, directory)).toHaveCount(1);
    await expect.soft.poll(() => contents(controller.page, directory)).not.toMatch(/Duplicate directory|Disconnected/);
    await a.app.close();
    await expect.poll(() => connected(controller.page, directory).then(items => items.length)).toBe(0);
    await expect.soft(cardLocator(controller.page, directory)).toHaveCount(1);
    await expect.soft.poll(() => contents(controller.page, directory)).toContain('Disconnected');
    await expect.soft.poll(() => contents(controller.page, directory)).not.toContain('Duplicate directory');
    const retained = cardLocator(controller.page, directory).last();
    await dismissLocator(retained).click();
    await expect.soft(cardLocator(controller.page, directory)).toHaveCount(0);
    const replacement = await h.launch(terminalTarget, directory);
    await expect.poll(() => connected(controller.page, directory).then(items => items.length)).toBe(1);
    await expect.soft(cardLocator(controller.page, directory)).toHaveCount(1);
    await expect.soft.poll(() => contents(controller.page, directory)).not.toMatch(/Duplicate directory|Disconnected/);
    await command(replacement.page, "printf 'REPLACEMENT_%s\\n' 'ALIVE'", 'REPLACEMENT_ALIVE');
    await controller.app.close();
    const restarted = await h.launch(controllerTarget, h.fixture.nonGit, { profile: controller.profile });
    await expect.poll(() => connected(restarted.page, directory).then(items => items.length)).toBe(1);
    await expect.soft(cardsLocator(restarted.page)).toHaveCount(2);
    await command(replacement.page, "printf 'RESTART_%s\\n' 'ALIVE'", 'RESTART_ALIVE');
  } finally { await h.dispose(); }
});

test('overlap hides a real pending gate without resolving it and restores current survivor status', { tag: '@ownapp' }, async () => {
  test.setTimeout(180_000);
  const h = await createControllerDesktopHarness();
  const repo = seedAutoGateRepo('controller-conflict-gate-', 'red');
  const { binDir, logFile } = seedFakeGhGit('controller-conflict-tools-', { realCommitOps: true });
  try {
    seedTrustedFlow(h.fixture.home, repo, 'conflict-gate-flow', autoGateFlowYaml([
      { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'auto' }, { id: 'verify', kind: 'manual' },
    ], 'conflict-gate-flow'));
    const hold = join(binDir, 'verdict-hold');
    writeFileSync(hold, 'hold');
    seedFakeAgentV2(binDir, { holdConsolidate: { sentinel: hold }, stepId: 'red', artifactRel: '.agent-terminal/loop/artifacts/red-result.json', work: 'red', logInjected: true, roster: loopRoster('red-loop'), verdicts: [exampleConsolidatorOutput('stop for a human', loopRoster('red-loop'))] });
    Object.assign(h.fixture.env, { PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile, CLAUDE_CONFIG_DIR: exampleConfigDir, APP_SUBMIT_DELAY_MS: '100' });
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const a = await h.launch(terminalTarget, repo);
    await a.page.locator('.xterm-screen').click();
    await a.page.keyboard.type(`cd ${shellQuote(repo)}; fake-agent`);
    await a.page.keyboard.press('Enter');
    const control = a.page.locator('#flow-strip .flow-control');
    await expect(control).toHaveText('Start');
    await control.click();
    await expect.poll(() => existsSync(`${hold}.pids`), { timeout: 60_000 }).toBe(true);
    const b = await h.launch(terminalTarget, repo);
    const c = await h.launch(terminalTarget, repo);
    await expect.poll(() => connected(controller.page, repo).then(items => items.length)).toBe(3);
    for (const target of [a, b, c]) await target.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    rmSync(hold);
    const stateFile = join(repo, '.agent-terminal/loop/run-state.yaml');
    await expect.poll(() => { try { return readFileSync(stateFile, 'utf8'); } catch { return ''; } }, { timeout: 60_000 }).toContain('verdict: stop for a human');
    const inputFile = join(repo, '.agent-terminal/injected-log');
    await expect.poll(() => readFileSync(inputFile, 'utf8')).toContain('Change no files and write no done-file: this is a question, not a turn.');
    const inputBefore = readFileSync(inputFile, 'utf8');
    const before = readFileSync(stateFile, 'utf8');
    const source = await a.page.evaluate(directory => window.flow.state(directory), repo);
    expect(source.loop?.humanNeeded).toBe(true);
    await expect.poll(() => connected(controller.page, repo).then(items => items.some(item => item.work?.attention !== null && item.work?.attention !== undefined))).toBe(true);
    await expect.soft(cardLocator(controller.page, repo)).toHaveCount(1);
    await expect.soft.poll(() => contents(controller.page, repo)).not.toMatch(/conflict-gate-flow|Human needed|stop for a human|Flow:|Step:/i);
    const first = cardLocator(controller.page, repo).first();
    await expect(headerActivationLocator(first), 'header icon on the duplicate card').toBeVisible();
    await expect.soft(bringForwardLocator(first), 'one activation control on the card').toHaveCount(1);
    await headerActivationLocator(first).click();
    await expect.soft.poll(() => Promise.all([a, b, c].map(target => target.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())))).toEqual([true, true, true]);
    expect.soft(readFileSync(stateFile, 'utf8')).toBe(before);
    expect.soft((await a.page.evaluate(directory => window.flow.state(directory), repo)).loop?.humanNeeded).toBe(true);
    await a.page.locator('.xterm-screen').click();
    await a.page.keyboard.type('CONFLICT_INPUT_BARRIER');
    await a.page.keyboard.press('Enter');
    await expect.poll(() => readFileSync(inputFile, 'utf8')).toContain('CONFLICT_INPUT_BARRIER\n');
    expect.soft(readFileSync(inputFile, 'utf8')).toBe(`${inputBefore}CONFLICT_INPUT_BARRIER\n`);
    await b.app.close();
    await c.app.close();
    await expect.poll(() => connected(controller.page, repo).then(items => items.length)).toBe(1);
    await expect.soft(cardLocator(controller.page, repo)).toHaveCount(1);
    await expect.soft.poll(() => contents(controller.page, repo)).toContain('conflict-gate-flow');
    await expect.soft.poll(() => contents(controller.page, repo)).toContain(source.loop!.verdictReason!);
    await expect.soft.poll(() => contents(controller.page, repo)).not.toMatch(/Duplicate directory|Disconnected/);
    expect.soft(readFileSync(stateFile, 'utf8')).toBe(before);
  } finally {
    try { await h.dispose(); }
    finally { rmSync(repo, { recursive: true, force: true }); rmSync(binDir, { recursive: true, force: true }); }
  }
});

test('an unconfirmed captured peer does not prevent a real window restoring or activate a later replacement', { tag: '@ownapp' }, async () => {
  const h = await createControllerDesktopHarness();
  const { registerControllerTerminal } = await import('../../src/main/controllerClient');
  let socket: ReturnType<typeof connectWebSocket> | undefined;
  let stopReplacement: (() => void) | undefined;
  try {
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    socket = connectWebSocket(resolveControllerEndpoint(h.fixture.home));
    socket.on('error', () => socket?.terminate());
    const directory = h.fixture.worktrees[0];
    await once(socket, 'open');
    let requested = false;
    socket.on('message', (chunk: Buffer) => { if (parseControllerMessage(chunk.toString()).type === 'activate') requested = true; });
    socket.send(encodeControllerMessage({ version: CONTROLLER_PROTOCOL_MAJOR, type: 'register', launchDirectory: directory, repositoryRoot: null }));
    await expect.poll(() => connected(controller.page, directory).then(items => items.length)).toBe(1);
    const original = await h.launch(terminalTarget, directory);
    await expect.poll(() => connected(controller.page, directory).then(items => items.length)).toBe(2);
    await original.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await expect(headerActivationLocator(cardLocator(controller.page, directory).first()), 'header icon on the duplicate card').toBeVisible();
    await headerActivationLocator(cardLocator(controller.page, directory).first()).click();
    await expect.poll(() => requested).toBe(true);
    let replacementActivations = 0;
    stopReplacement = registerControllerTerminal(h.fixture.home, { launchDirectory: directory, repositoryRoot: null }, () => { replacementActivations++; return 'activated'; });
    await expect.poll(() => connected(controller.page, directory).then(items => items.length)).toBe(3);
    socket.terminate();
    await expect.soft.poll(() => original.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    await expect.soft(controller.page.getByRole('alert')).toContainText('Terminal unavailable');
    await expect.soft(controller.page.getByRole('alert')).toContainText(/1 (?:of|out of) 2/);
    expect.soft(replacementActivations).toBe(0);
    await original.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await command(original.page, "printf 'PARTIAL_%s\\n' 'ALIVE'", 'PARTIAL_ALIVE');
  } finally { socket?.terminate(); stopReplacement?.(); await h.dispose(); }
});
