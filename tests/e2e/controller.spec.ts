import { expect, test } from '@playwright/test';
import { join, resolve } from 'node:path';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createControllerHarness } from './controllerHarness';
import { shellQuote } from '../../src/shared/shellQuote';
import { createControllerDesktopHarness } from './controllerDesktop';
import { typeAtDesktop } from './controllerKeyboard';
import { seedAutoGateRepo, seedTrustedFlow, autoGateFlowYaml, loopRoster } from './autoGateHarness';
import { seedFakeGhGit, seedFakeAgentV2, exampleConfigDir } from './fakeTools';

test('controller explains how to connect the first terminal', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
    const controller = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
    await expect.soft(controller.page.locator('body')).toContainText(/no terminals (?:are )?connected/i);
    await expect.soft(controller.page.locator('body')).toContainText(/launch.*terminal.*controller.*running/i);
  } finally {
    await h.dispose();
  }
});

test('controller launches separately and identifies two independent terminals', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
    const controller = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
    const terminals = [];
    for (const directory of h.fixture.repositories) {
      const terminal = await h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, directory);
      terminals.push(terminal);
      await terminal.page.locator('.xterm-screen').click();
      await terminal.page.keyboard.type('printf "CONTROLLER_%s\\n" "$PWD"');
      await terminal.page.keyboard.press('Enter');
      await expect(terminal.page.locator('.xterm-rows')).toContainText(`CONTROLLER_${directory}`);
    }
    expect(new Set([controller, ...terminals].map(instance => instance.app.process().pid)).size).toBe(3);
    for (const directory of h.fixture.repositories) {
      await expect.soft(controller.page.getByRole('button', { name: directory, exact: false })).toHaveCount(1);
    }
  } finally {
    await h.dispose();
  }
});

test('controller keeps launch identity after real shell navigation', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
    const controller = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
    const destination = join(h.fixture.nonGit, "operator's directory");
    mkdirSync(destination);
    const original = h.fixture.worktrees[0];
    const terminal = await h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, original);
    await terminal.page.locator('.xterm-screen').click();
    await terminal.page.keyboard.type(`cd ${shellQuote(destination)} && printf 'NAVIGATED_%s\\n' "$PWD"`);
    await terminal.page.keyboard.press('Enter');
    await expect(terminal.page.locator('.xterm-rows')).toContainText(`NAVIGATED_${destination}`);
    await expect.soft(controller.page.getByRole('button', { name: original, exact: false })).toHaveCount(1);
    await expect(controller.page.getByRole('button', { name: destination, exact: false })).toHaveCount(0);
  } finally {
    await h.dispose();
  }
});

test('controller distinguishes two worktrees and a non-Git launch', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
    const controller = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
    for (const directory of [...h.fixture.worktrees, h.fixture.nonGit]) {
      await h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, directory);
    }
    for (const directory of [...h.fixture.worktrees, h.fixture.nonGit]) {
      await expect.soft(controller.page.getByRole('button', { name: directory, exact: false })).toHaveCount(1);
    }
  } finally {
    await h.dispose();
  }
});

test('controller presents separate terminals launched in the same directory', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
    const controller = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
    await h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, h.fixture.nonGit);
    await h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, h.fixture.nonGit);
    await expect(controller.page.getByRole('button', { name: h.fixture.nonGit, exact: false })).toHaveCount(2);
  } finally {
    await h.dispose();
  }
});

test('controller reflows real registered terminal controls when its window narrows', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
    const controller = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
    for (const directory of h.fixture.repositories) {
      await h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, directory);
    }
    const panes = controller.page.getByRole('button', { name: new RegExp(h.fixture.root) });
    await expect.soft(panes).toHaveCount(2);
    const measure = () => panes.evaluateAll((elements, directories) => {
      const boxes = elements.map(element => element.getBoundingClientRect());
      return {
        rows: new Set(boxes.map(box => Math.round(box.top))).size,
        reachable: boxes.length === 2 && boxes.every(box => box.width > 0 && box.height > 0
          && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight),
        separated: boxes.every((box, i) => boxes.slice(i + 1).every(other =>
          box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top)),
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        readable: directories.every(directory => elements.some(element => element.textContent?.includes(directory)))
          && elements.every(element => {
            const bounds = element.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(element);
            return [...range.getClientRects()].every(box => box.width > 0 && box.height > 0
              && box.left >= bounds.left && box.right <= bounds.right && box.top >= bounds.top && box.bottom <= bounds.bottom);
          }),
      };
    }, h.fixture.repositories);
    await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 700));
    await expect.poll(() => controller.page.evaluate(() => innerWidth)).toBe(1000);
    const wide = await measure();
    await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(320, 700));
    await expect.poll(() => controller.page.evaluate(() => innerWidth)).toBe(320);
    const narrow = await measure();
    expect.soft(narrow.rows).toBeGreaterThan(wide.rows);
    expect.soft(wide.reachable).toBe(true);
    expect.soft(narrow.reachable).toBe(true);
    expect.soft(wide.readable && narrow.readable).toBe(true);
    expect.soft(wide.separated && narrow.separated).toBe(true);
    expect.soft(wide.pageOverflow || narrow.pageOverflow).toBe(false);
  } finally {
    await h.dispose();
  }
});

test('closing the controller window minimizes it instead of exiting', { tag: '@ownapp' }, async () => {
  const h = await createControllerDesktopHarness();
  try {
    const controller = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
    const exited = new Promise<string>(resolve => controller.app.process().once('exit', () => resolve('exited')));
    const windowOutcome = controller.app.evaluate(({ BrowserWindow }) => new Promise<string>(resolve => {
      const window = BrowserWindow.getAllWindows()[0];
      window.once('minimize', () => resolve(window.isMinimized() ? 'minimized' : 'not minimized'));
      window.once('closed', () => resolve('closed'));
      window.close();
    }));
    const outcome = await Promise.race([windowOutcome.catch(() => exited), exited]);
    expect(outcome).toBe('minimized');
  } finally {
    await h.dispose();
  }
});

test('terminals continue real PTY work after the controller explicitly quits', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
    const controller = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
    const terminals = await Promise.all(h.fixture.repositories.map(directory =>
      h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, directory)));
    for (const directory of h.fixture.repositories) {
      await expect.soft(controller.page.getByRole('button', { name: directory, exact: false })).toHaveCount(1);
    }
    await controller.app.close();
    for (const [index, terminal] of terminals.entries()) {
      await terminal.page.locator('.xterm-screen').click();
      await terminal.page.keyboard.type(`printf 'AFTER_QUIT_%s\\n' ${shellQuote(String(index))}`);
      await terminal.page.keyboard.press('Enter');
      await expect(terminal.page.locator('.xterm-rows')).toContainText(`AFTER_QUIT_${index}`);
    }
  } finally { await h.dispose(); }
});

test('controller retains disconnected identities while another terminal remains activatable', { tag: '@ownapp' }, async () => {
  const h = await createControllerDesktopHarness();
  try {
    const controller = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
    const terminals = await Promise.all(h.fixture.repositories.map(directory =>
      h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, directory)));
    await expect.soft(controller.page.getByRole('button')).toHaveCount(2);
    await terminals[0].app.close();
    await expect.soft(controller.page.locator('body')).toContainText(h.fixture.repositories[0]);
    await expect.soft(controller.page.locator('body')).toContainText(/disconnected/i);
    await expect.soft(controller.page.getByRole('button', { name: h.fixture.repositories[1], exact: false })).toHaveCount(1);
    await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
    await expect.poll(() => controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
    await controller.page.getByRole('button', { name: h.fixture.repositories[1], exact: false }).click();
    await expect.soft.poll(() => terminals[1].app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
    await terminals[1].page.locator('.xterm-screen').click();
    await terminals[1].page.keyboard.type("printf 'SURVIVOR_%s\\n' 'ALIVE'");
    await terminals[1].page.keyboard.press('Enter');
    await expect(terminals[1].page.locator('.xterm-rows')).toContainText('SURVIVOR_ALIVE');
    await terminals[1].app.close();
    await expect.soft(controller.page.locator('body')).toContainText(h.fixture.repositories[1]);
    await expect.soft(controller.page.locator('body')).not.toContainText(/no terminals (?:are )?connected/i);
  } finally { await h.dispose(); }
});

test('clicking each pane focuses its original terminal after shell navigation', { tag: '@ownapp' }, async () => {
  const h = await createControllerDesktopHarness();
  try {
    const controller = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
    const terminals = await Promise.all(h.fixture.repositories.map(directory =>
      h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, directory)));
    await terminals[0].page.locator('.xterm-screen').click();
    await terminals[0].page.keyboard.type(`cd ${shellQuote(h.fixture.nonGit)} && printf 'ACTIVATION_NAV_%s\\n' "$PWD"`);
    await terminals[0].page.keyboard.press('Enter');
    await expect(terminals[0].page.locator('.xterm-rows')).toContainText(`ACTIVATION_NAV_${h.fixture.nonGit}`);
    for (const [index, directory] of h.fixture.repositories.entries()) {
      await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
      await expect.poll(() => controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
      await controller.page.getByRole('button', { name: directory, exact: false }).click();
      await expect.soft.poll(() => terminals[index].app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
      expect.soft(await terminals[1 - index].app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(false);
    }
  } finally { await h.dispose(); }
});

test('clicking a pane restores its minimized terminal window', { tag: '@ownapp' }, async () => {
  const h = await createControllerDesktopHarness();
  try {
    const controller = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
    const terminal = await h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, h.fixture.repositories[0]);
    await terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await expect.poll(() => terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
    await controller.page.getByRole('button', { name: h.fixture.repositories[0], exact: false }).click();
    await expect.soft.poll(() => terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(false);
    await expect.soft.poll(() => terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
  } finally { await h.dispose(); }
});

test('controller retains its connected terminals across close and restore and can activate each', { tag: '@ownapp' }, async () => {
  const h = await createControllerDesktopHarness();
  try {
    const controller = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
    const terminals = await Promise.all(h.fixture.repositories.map(directory =>
      h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, directory)));
    await expect(controller.page.getByRole('button')).toHaveCount(2);
    const identities = () => controller.page.evaluate(async () => {
      let unsubscribe!: () => void;
      const ids = await new Promise<string[]>(resolve => {
        unsubscribe = window.controller.subscribeTerminals(items => resolve(items.map(item => item.id).sort()));
      });
      unsubscribe();
      return ids;
    });
    const before = await identities();
    await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
    await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    expect.soft(await identities()).toEqual(before);
    for (const [index, directory] of h.fixture.repositories.entries()) {
      await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
      await expect.poll(() => controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
      await controller.page.getByRole('button', { name: directory, exact: false }).click();
      await expect.soft.poll(() => terminals[index].app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
    }
  } finally { await h.dispose(); }
});

for (const action of ['activate', 'close-and-restore', 'quit', 'crash-and-recover', 'quit-and-recover'] as const) {
  test(`controller ${action} preserves a waiting human gate and sends no agent input`, { tag: '@ownapp' }, async () => {
    test.setTimeout(120_000);
    const h = await createControllerDesktopHarness();
    const repo = seedAutoGateRepo('at-c1-gate-', 'groom', { ticket: '217' });
    const { binDir, logFile } = seedFakeGhGit('at-c1-tools-', { realCommitOps: true });
    try {
      seedTrustedFlow(h.fixture.home, repo, 'human-groom', autoGateFlowYaml([
        { id: 'groom', kind: 'loop', loop: 'groom-loop', authority: 'human' },
      ]));
      seedFakeAgentV2(binDir, {
        stepId: 'groom', artifactRel: '.agent-terminal/loop/artifacts/groomed-ticket.md',
        work: 'complete', roster: loopRoster('groom-loop'), logInjected: true,
      });
      Object.assign(h.fixture.env, {
        PATH: `${binDir}:${h.fixture.env.PATH}`, FAKE_GHGIT_LOG: logFile,
        CLAUDE_CONFIG_DIR: exampleConfigDir, APP_SUBMIT_DELAY_MS: '100',
      });
      const controller = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
      const terminal = await h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, repo);
      await expect(controller.page.getByRole('button', { name: repo, exact: false })).toHaveCount(1);
      await expect(terminal.page.locator('.xterm-rows')).not.toHaveText('');
      await terminal.page.locator('.xterm-screen').click();
      await terminal.page.keyboard.type('fake-agent');
      await terminal.page.keyboard.press('Enter');
      await terminal.page.locator('#flow-strip .flow-control').click();
      const read = (relative: string) => readFileSync(join(repo, '.agent-terminal', relative), 'utf8');
      await expect.poll(() => read('loop/run-state.yaml'), { timeout: 60_000 }).toContain('verdict: clean');
      await terminal.page.locator('#flow-strip .loopstat').click();
      const approve = terminal.page.locator('#loop-panel [data-gate-option="approve"]');
      await expect(approve).toBeVisible();
      await expect.poll(() => read('injected-log')).toContain('Change no files and write no done-file: this is a question, not a turn.');
      const before = { flow: read('flow-state.yaml'), loop: read('loop/run-state.yaml'), input: read('injected-log') };
      expect(before.flow).toMatch(/^step: groom$/m);
      expect(before.input.length).toBeGreaterThan(0);
      await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
      if (action === 'activate') {
        await controller.page.getByRole('button', { name: repo, exact: false }).click();
        await expect.soft.poll(() => terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
      } else if (action === 'close-and-restore') {
        await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
        await expect.poll(() => controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
        await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
        await expect(controller.page.getByRole('button', { name: repo, exact: false })).toHaveCount(1);
      } else {
        if (action === 'crash-and-recover') await h.crash(controller.app);
        else await controller.app.close();
        if (action === 'crash-and-recover' || action === 'quit-and-recover') {
          await expect.soft(approve).toBeVisible();
          expect.soft({ flow: read('flow-state.yaml'), loop: read('loop/run-state.yaml'), input: read('injected-log') }).toEqual(before);
          const recovered = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
          await expect.soft(recovered.page.getByRole('button', { name: repo, exact: false })).toHaveCount(1, { timeout: 10_000 });
          await recovered.page.getByRole('button', { name: repo, exact: false })
            .evaluateAll(buttons => (buttons[0] as HTMLButtonElement | undefined)?.click());
        }
      }
      await expect.soft(approve).toBeVisible();
      expect.soft({ flow: read('flow-state.yaml'), loop: read('loop/run-state.yaml'), input: read('injected-log') }).toEqual(before);
      await terminal.page.locator('.xterm-screen').click();
      await terminal.page.keyboard.type('C1_INPUT_BARRIER');
      await terminal.page.keyboard.press('Enter');
      await expect.poll(() => read('injected-log')).toContain('C1_INPUT_BARRIER\n');
      expect.soft(read('injected-log')).toBe(`${before.input}C1_INPUT_BARRIER\n`);
      expect.soft({ flow: read('flow-state.yaml'), loop: read('loop/run-state.yaml') }).toEqual({ flow: before.flow, loop: before.loop });
      if (action === 'crash-and-recover' || action === 'quit-and-recover') {
        await approve.click();
        await expect.poll(() => read('flow-state.yaml'), { timeout: 30_000 }).toMatch(/^status: done$/m);
      }
    } finally {
      try { await h.dispose(); }
      finally { rmSync(repo, { recursive: true, force: true }); rmSync(binDir, { recursive: true, force: true }); }
    }
  });
}

test('pane activation delivers desktop keyboard input only to the selected terminal', { tag: '@ownapp' }, async () => {
  const h = await createControllerDesktopHarness();
  try {
    const controller = await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
    const terminals = await Promise.all(h.fixture.repositories.map(directory =>
      h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, directory)));
    for (const [index, terminal] of terminals.entries()) {
      await terminal.page.locator('.xterm-screen').click();
      await terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
      typeAtDesktop(`printf 'DESKTOP_READY_%s\\n' ${shellQuote(String(index))}`, h.fixture.env);
      await expect(terminal.page.locator('.xterm-rows')).toContainText(`DESKTOP_READY_${index}`);
      await terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await expect.poll(() => terminal.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
    }
    for (const [index, directory] of h.fixture.repositories.entries()) {
      await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
      await expect.poll(() => controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
      await controller.page.getByRole('button', { name: directory, exact: false }).click();
      await expect.soft.poll(() => terminals[index].app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
      typeAtDesktop(`printf 'DESKTOP_TARGET_%s\\n' ${shellQuote(String(index))}`, h.fixture.env);
      await expect.soft(terminals[index].page.locator('.xterm-rows')).toContainText(`DESKTOP_TARGET_${index}`);
      await expect.soft(terminals[1 - index].page.locator('.xterm-rows')).not.toContainText(`DESKTOP_TARGET_${index}`);
    }
  } finally { await h.dispose(); }
});
