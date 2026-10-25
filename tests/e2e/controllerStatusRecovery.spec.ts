import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { connect, createServer, type Socket } from 'node:net';
import { createControllerDesktopHarness } from './controllerDesktop';
import { statusDeadline } from './controllerStatusDeadline';
import { autoGateFlowYaml, loopRoster, seedAutoGateRepo, seedTrustedFlow } from './autoGateHarness';
import { exampleConfigDir, seedFakeAgentV2, seedFakeGhGit } from './fakeTools';
import { exampleConsolidatorOutput } from '../../src/shared/consolidatorOutput';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { shellQuote } from '../../src/shared/shellQuote';

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };

for (const outage of ['socket', 'exit', 'crash'] as const) {
  test(`real human attention across ${outage} is truthful after loss and current after recovery`, { tag: '@ownapp' }, async () => {
    test.setTimeout(120_000);
    const h = await createControllerDesktopHarness();
    const repo = seedAutoGateRepo('controller-recovery-gate-', 'red');
    const { binDir, logFile } = seedFakeGhGit('controller-recovery-tools-', { realCommitOps: true });
    const controllerHome = join(h.fixture.root, 'controller');
    const endpoint = resolveControllerEndpoint(h.fixture.home);
    mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
    const sockets = new Set<Socket>();
    let online = true;
    const relay = createServer(downstream => {
      if (!online) { downstream.destroy(); return; }
      const upstream = connect(resolveControllerEndpoint(controllerHome));
      for (const socket of [downstream, upstream]) {
        sockets.add(socket);
        socket.on('error', () => socket.destroy());
        socket.on('close', () => { sockets.delete(socket); downstream.destroy(); upstream.destroy(); });
      }
      downstream.pipe(upstream).pipe(downstream);
    });
    try {
      await new Promise<void>(resolve => relay.listen(endpoint, resolve));
      seedTrustedFlow(h.fixture.home, repo, 'recovery-flow', autoGateFlowYaml([
        { id: 'red', kind: 'loop', loop: 'red-loop', authority: 'auto' }, { id: 'verify', kind: 'manual' },
      ], 'recovery-flow'));
      seedFakeAgentV2(binDir, { stepId: 'red', artifactRel: '.agent-terminal/loop/artifacts/red-result.json', work: 'red',
        roster: loopRoster('red-loop'), verdicts: [exampleConsolidatorOutput('stop for a human', loopRoster('red-loop'))] });
      Object.assign(h.fixture.env, { PATH: `${binDir}:${process.env.PATH}`, FAKE_GHGIT_LOG: logFile, CLAUDE_CONFIG_DIR: exampleConfigDir, APP_SUBMIT_DELAY_MS: '100' });
      h.fixture.env.APP_HOME_DIR = controllerHome;
      let controller = await h.launch(controllerTarget, h.fixture.nonGit);
      h.fixture.env.APP_HOME_DIR = h.fixture.home;
      const terminal = await h.launch(terminalTarget, repo);
      await terminal.page.locator('.xterm-screen').click();
      await terminal.page.keyboard.type(`cd ${shellQuote(repo)}; fake-agent`);
      await terminal.page.keyboard.press('Enter');
      const control = terminal.page.locator('#flow-strip .flow-control');
      await expect(control).toHaveText('Start');
      await control.click();
      const stateFile = join(repo, '.agent-terminal', 'loop', 'run-state.yaml');
      await expect.poll(() => existsSync(stateFile) ? readFileSync(stateFile, 'utf8') : '', { timeout: 60_000 }).toContain('verdict: stop for a human');
      const readout = terminal.page.locator('#flow-strip .loopstat');
      if (await readout.getAttribute('aria-expanded') !== 'true') await readout.click();
      const approve = terminal.page.locator('#loop-panel [data-gate-option="approve"]');
      await expect(approve).toBeVisible();
      const source = await terminal.page.evaluate(directory => window.flow.state(directory), repo);
      expect(source.loop?.humanNeeded).toBe(true);
      await expect(controller.page.getByRole('button', { name: repo, exact: false })).toContainText(/Human needed/);
      const starts = readFileSync(join(h.fixture.root, 'shell-starts'), 'utf8');
      if (outage === 'exit') await terminal.app.close();
      else {
        online = false;
        for (const socket of sockets) socket.destroy();
        if (outage === 'crash') await h.crash(controller.app);
      }
      if (outage !== 'crash') {
        await expect(controller.page.getByText(/Disconnected: terminal unavailable/)).toBeVisible();
        const text = await controller.page.locator('body').innerText();
        expect.soft(!/Human needed/.test(text) || /last.known/i.test(text)).toBe(true);
        await expect.soft(controller.page.getByRole('button', { name: new RegExp(`^${repo}`) })).toHaveCount(0);
      }
      if (outage === 'exit') {
        await controller.page.getByRole('button', { name: /Dismiss disconnected/ }).click();
        await expect(controller.page.getByText(/No terminals connected/)).toBeVisible();
        await expect.soft(controller.page.getByRole('status')).not.toContainText(/Human needed|stop for a human/);
      } else {
        await approve.click();
        await expect(terminal.page.locator('#flow-strip')).toContainText('verify');
        await expect.poll(async () => (await terminal.page.evaluate(directory => window.flow.state(directory), repo)).stepName).toBe('verify');
        if (outage === 'crash') {
          h.fixture.env.APP_HOME_DIR = controllerHome;
          controller = await h.launch(controllerTarget, h.fixture.nonGit);
          h.fixture.env.APP_HOME_DIR = h.fixture.home;
        }
        const current = await statusDeadline(controller.page, repo, [/verify/, /recovery-flow/], 'registration');
        online = true;
        const observed = await current();
        expect.soft(observed.matched).toEqual([true, true]);
        expect.soft(observed.texts.every(text => !/Human needed|stop for a human/.test(text))).toBe(true);
        await expect.soft(controller.page.getByRole('status')).not.toContainText(/Human needed|stop for a human/);
        const pane = controller.page.getByRole('button', { name: repo, exact: false });
        await expect.soft(pane).toHaveCount(1);
        await pane.click();
        await expect.soft.poll(() => terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
        expect.soft((await terminal.page.evaluate(directory => window.flow.state(directory), repo)).stepName).toBe('verify');
        expect.soft(readFileSync(join(h.fixture.root, 'shell-starts'), 'utf8')).toBe(starts);
      }
    } finally {
      try { await h.dispose(); }
      finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => relay.close(() => resolve()));
        rmSync(repo, { recursive: true, force: true }); rmSync(binDir, { recursive: true, force: true });
      }
    }
  });
}

test('repeated recovery keeps same-directory peers distinct after work context changes and preserves PTY input', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const h = await createControllerDesktopHarness();
  const [a, b] = h.fixture.repositories;
  try {
    for (const [index, repo] of [a, b].entries()) {
      mkdirSync(join(repo, '.agent-terminal'), { recursive: true });
      seedTrustedFlow(h.fixture.home, repo, `recovery-${index}`, autoGateFlowYaml([{ id: `first-${index}`, kind: 'manual' }, { id: `next-${index}`, kind: 'manual' }], `recovery-${index}`));
      writeFileSync(join(repo, '.agent-terminal', 'flow-state.yaml'), `step: first-${index}\nstatus: not_started\n`);
    }
    let controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const terminals = [await h.launch(terminalTarget, a), await h.launch(terminalTarget, a)];
    for (const [index, terminal] of terminals.entries()) {
      await terminal.page.locator('.xterm-screen').click();
      await terminal.page.keyboard.type(`export RECOVERY_PEER=${index}`);
      await terminal.page.keyboard.press('Enter');
    }
    await expect(controller.page.getByRole('button', { name: a, exact: false })).toHaveCount(2);
    for (let round = 0; round < 2; round++) {
      await h.crash(controller.app);
      if (round === 0) {
        await terminals[0].page.locator('.xterm-screen').click();
        await terminals[0].page.keyboard.type(`cd ${shellQuote(b)}`);
        await terminals[0].page.keyboard.press('Enter');
        await expect(terminals[0].page.locator('#flow-strip .flow-control')).toHaveText('Start');
      }
      await terminals[0].page.locator('#flow-strip .flow-control').click();
      await expect(terminals[0].page.locator('#flow-strip')).toContainText(round === 0 ? 'first-1' : 'next-1');
      for (const [index, terminal] of terminals.entries()) {
        await terminal.page.locator('.xterm-screen').click();
        await terminal.page.keyboard.type(`printf 'RECOVER_${round}_%s\\n' "$RECOVERY_PEER"`);
        await terminal.page.keyboard.press('Enter');
        await expect(terminal.page.locator('.xterm-rows')).toContainText(`RECOVER_${round}_${index}`);
      }
      controller = await h.launch(controllerTarget, h.fixture.nonGit);
      await expect(controller.page.getByRole('button', { name: a, exact: false })).toHaveCount(2, { timeout: 10_000 });
      const panes = controller.page.getByRole('button', { name: a, exact: false });
      await expect.soft(panes.filter({ hasText: 'recovery-1' })).toContainText(round === 0 ? 'first-1' : 'next-1', { timeout: 2_000 });
      await expect.soft(panes.filter({ hasText: 'recovery-0' })).toContainText('first-0', { timeout: 2_000 });
      expect.soft(readFileSync(join(h.fixture.root, 'shell-starts'), 'utf8')).toBe('started\nstarted\n');
      await expect.soft(controller.page.getByRole('button', { name: b, exact: false })).toHaveCount(0);
    }
  } finally { await h.dispose(); }
});
