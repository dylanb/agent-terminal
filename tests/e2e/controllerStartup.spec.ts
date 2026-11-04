import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type WebSocket from 'ws';
import { createWebSocketTestServer } from '../helpers/controllerWebSocket';
import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { createControllerHarness } from './controllerHarness';
import { load } from 'js-yaml';
import { seedTrustedFlow, autoGateFlowYaml } from './autoGateHarness';
import { resolveControllerEndpoint } from '../../src/main/controllerEndpoint';
import { cardLocator } from '../helpers/controllerCards';
import { STARTUP_CARD } from '../helpers/startupCard';

const RETRY_OBSERVATION_MS = 8_100;
const UNCONFIRMED_OBSERVATION_MS = 500;
const STARTUP_BUDGET_MS = 30_000;

const terminalTarget = { kind: 'development' as const, entry: resolve('out/main/index.js') };
const controllerTarget = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
const starts = (root: string) => existsSync(join(root, 'shell-starts')) ? readFileSync(join(root, 'shell-starts'), 'utf8') : '';

test('startup waiting card shows and starts no shell when closed before the controller starts', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
    const terminal = await h.launch(terminalTarget, h.fixture.nonGit);
    await expect.soft(terminal.page.getByRole('heading', { name: STARTUP_CARD.heading, exact: true })).toBeVisible();
    expect.soft(starts(h.fixture.root)).toBe('');
    await expect.poll(() => terminal.page.evaluate(() => document.readyState)).toBe('complete');
    const startsAtClose = starts(h.fixture.root);
    const child = terminal.app.process();
    await terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => child.exitCode).not.toBeNull();
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    await delay(RETRY_OBSERVATION_MS);
    expect.soft(starts(h.fixture.root)).toBe(startsAtClose);
    await expect(cardLocator(controller.page, h.fixture.nonGit)).toHaveCount(0);
  } finally { await h.dispose(); }
});

test('the waiting card installs the agent-terminal command before any controller has run', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
    const home = join(h.fixture.root, 'user-home');
    const userBin = join(home, '.local', 'bin');
    mkdirSync(userBin, { recursive: true, mode: 0o755 });
    const terminal = await h.launch(terminalTarget, h.fixture.nonGit, {
      env: { HOME: home, PATH: `${userBin}:${h.fixture.env.PATH}` },
    });
    const card = terminal.page.locator('#startup-waiting');
    await expect(card.getByRole('heading', { name: STARTUP_CARD.heading, exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Install the agent-terminal command-line launcher' }).click();
    const launcher = join(userBin, 'agent-terminal');
    await expect(card.getByRole('status').filter({ hasText: launcher })).toContainText(`Installed agent-terminal at ${launcher}`);
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
    expect(readFileSync(launcher, 'utf8')).toContain('--controller');
    await expect(card.getByText('agent-terminal --controller', { exact: false }).first()).toBeVisible();
    expect(starts(h.fixture.root)).toBe('');
  } finally { await h.dispose(); }
});

test('a launcher installed from a dev build started on the app root launches the built controller', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
    const home = join(h.fixture.root, 'user-home');
    const userBin = join(home, '.local', 'bin');
    mkdirSync(userBin, { recursive: true, mode: 0o755 });
    const terminal = await h.launch({ kind: 'development', entry: resolve('.') }, h.fixture.nonGit, {
      env: { HOME: home, PATH: `${userBin}:${h.fixture.env.PATH}` },
    });
    const card = terminal.page.locator('#startup-waiting');
    await card.getByRole('button', { name: 'Install the agent-terminal command-line launcher' }).click();
    const launcher = join(userBin, 'agent-terminal');
    await expect(card.getByRole('status').filter({ hasText: launcher })).toContainText(`Installed agent-terminal at ${launcher}`);
    const electron = await terminal.app.evaluate(() => process.execPath);

    const fakeBin = join(h.fixture.root, 'recording-bin');
    const recorded = join(h.fixture.root, 'nohup-args');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      join(fakeBin, 'nohup'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${recorded}.tmp" && mv "${recorded}.tmp" "${recorded}"\n`,
      { mode: 0o755 },
    );
    const run = spawnSync(launcher, ['--controller'], {
      env: { ...h.fixture.env, HOME: home, PATH: `${fakeBin}:${h.fixture.env.PATH}` },
      encoding: 'utf8',
    });
    expect(run.stderr).toBe('');
    await expect
      .poll(() => (existsSync(recorded) ? readFileSync(recorded, 'utf8').trimEnd().split('\n') : []))
      .toEqual([electron, resolve('out/main/controller.js')]);
  } finally { await h.dispose(); }
});

test('startup automatically registers after controller launch and starts exactly once', { tag: '@ownapp' }, async () => {
  test.setTimeout(120_000);
  const h = createControllerHarness();
  try {
    const terminal = await h.launch(terminalTarget, h.fixture.nonGit);
    await expect(terminal.page.getByRole('heading', { name: STARTUP_CARD.heading, exact: true })).toBeVisible();
    const statuses = terminal.page.locator('#startup-waiting').getByRole('status');
    await expect.soft(statuses.filter({ hasNotText: STARTUP_CARD.statusLine })).toHaveText(['', '']);
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    await expect.soft(cardLocator(controller.page, h.fixture.nonGit)).toHaveCount(1, { timeout: STARTUP_BUDGET_MS });
    await expect.soft.poll(() => starts(h.fixture.root)).toBe('started\n');
    await expect(terminal.page.locator('.xterm-screen')).toBeVisible();
    await expect.soft(terminal.page.getByRole('heading', { name: STARTUP_CARD.heading, exact: true })).toBeHidden();
    await expect.soft(terminal.page.getByText(STARTUP_CARD.statusLine)).toBeHidden();
    await terminal.page.locator('.xterm-screen').click();
    await terminal.page.keyboard.type('printf "STARTUP_%s\\n" "READY"');
    await terminal.page.keyboard.press('Enter');
    await expect(terminal.page.locator('.xterm-rows')).toContainText('STARTUP_READY');
    await delay(RETRY_OBSERVATION_MS);
    expect.soft(starts(h.fixture.root)).toBe('started\n');
    await expect.soft(cardLocator(controller.page, h.fixture.nonGit)).toHaveCount(1);
  } finally { await h.dispose(); }
});

test('startup with a running controller publishes a usable pane and starts one real shell', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
    const controller = await h.launch(controllerTarget, h.fixture.nonGit);
    const terminal = await h.launch(terminalTarget, h.fixture.nonGit);
    await expect(cardLocator(controller.page, h.fixture.nonGit)).toHaveCount(1);
    await expect.poll(() => starts(h.fixture.root)).toBe('started\n');
    await terminal.page.locator('.xterm-screen').click();
    await terminal.page.keyboard.type('printf "PRESENT_%s\\n" "READY"');
    await terminal.page.keyboard.press('Enter');
    await expect(terminal.page.locator('.xterm-rows')).toContainText('PRESENT_READY');
  } finally { await h.dispose(); }
});

for (const mode of ['delayed', 'silent', 'malformed', 'interrupted', 'late-after-close'] as const) {
  test(`startup does not release work for ${mode} registration`, { tag: '@ownapp' }, async () => {
    test.setTimeout(120_000);
    const h = createControllerHarness();
    const peers = new Set<WebSocket>();
    const registrations: Array<{ socket: WebSocket }> = [];
    const endpoint = resolveControllerEndpoint(h.fixture.home);
    mkdirSync(dirname(endpoint), { recursive: true, mode: 0o700 });
    const peer = createWebSocketTestServer(socket => {
      peers.add(socket);
      socket.on('error', () => socket.terminate());
      socket.once('message', () => {
        registrations.push({ socket });
        if (mode === 'malformed') socket.send('not JSON');
        if (mode === 'interrupted') socket.terminate();
      });
    });
    try {
      await new Promise<void>(resolve => peer.listen(endpoint, resolve));
      const terminal = await h.launch(terminalTarget, h.fixture.nonGit);
      await expect.poll(() => registrations.length).toBeGreaterThan(0);
      await delay(UNCONFIRMED_OBSERVATION_MS);
      expect.soft(starts(h.fixture.root)).toBe('');
      if (mode === 'delayed' || mode === 'silent') {
        if (mode === 'silent') {
          await expect.soft.poll(() => registrations.length, { timeout: STARTUP_BUDGET_MS }).toBeGreaterThan(1);
          expect.soft(starts(h.fixture.root)).toBe('');
        }
        registrations[registrations.length - 1].socket.send('{"version":2,"type":"registered"}\n');
        await expect.poll(() => starts(h.fixture.root)).toBe('started\n');
        await delay(UNCONFIRMED_OBSERVATION_MS);
        expect(starts(h.fixture.root)).toBe('started\n');
      } else if (mode === 'late-after-close') {
        const startsAtClose = starts(h.fixture.root);
        const child = terminal.app.process();
        await terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
        await expect.poll(() => child.exitCode).not.toBeNull();
        registrations[0].socket.send('{"version":2,"type":"registered"}\n');
        await delay(RETRY_OBSERVATION_MS);
        expect.soft(starts(h.fixture.root)).toBe(startsAtClose);
        expect(registrations).toHaveLength(1);
      } else {
        await expect.soft(terminal.page.getByRole('heading', { name: STARTUP_CARD.heading, exact: true })).toBeVisible();
        await expect.soft.poll(() => registrations.length, { timeout: STARTUP_BUDGET_MS }).toBeGreaterThan(1);
        await delay(RETRY_OBSERVATION_MS);
        expect.soft(starts(h.fixture.root)).toBe('');
      }
    } finally {
      await h.dispose();
      for (const socket of peers) socket.terminate();
      await new Promise<void>(resolve => peer.close(() => resolve()));
    }
  });
}


test('startup waiting cannot be bypassed by terminal input or flow start', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  const repo = h.fixture.repositories[0];
  try {
    seedTrustedFlow(h.fixture.home, repo, 'waiting', autoGateFlowYaml([{ id: 'work', kind: 'manual' }]));
    const state = join(repo, '.agent-terminal', 'flow-state.yaml');
    writeFileSync(state, 'step: work\nstatus: not_started\n');
    const terminal = await h.launch(terminalTarget, repo);
    await terminal.page.evaluate(directory => {
      window.term.input('printf "INPUT_BYPASS\\n"\r');
      window.monitor.inject({ text: 'printf "INJECT_BYPASS\\n"', submit: true });
      void window.flow.start(directory).catch(() => {});
    }, repo);
    await delay(UNCONFIRMED_OBSERVATION_MS);
    expect.soft(starts(h.fixture.root)).toBe('');
    expect.soft(load(readFileSync(state, 'utf8'))).toMatchObject({ status: 'not_started' });
  } finally { await h.dispose(); }
});
