import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createControllerHarness } from './controllerHarness';

test('controller harness owns crash, restart and real shell startup evidence', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  const root = h.fixture.root;
  try {
    const target = { kind: 'development' as const, entry: resolve('out/main/controller.js') };
    const controller = await h.launch(target, h.fixture.nonGit);
    const child = controller.app.process();
    await h.crash(controller.app);
    expect(child.signalCode).toBe('SIGKILL');
    const restarted = await h.launch(target, h.fixture.nonGit);
    await expect(restarted.page.locator('body')).toContainText(/no terminals (?:are )?connected/i);
    const terminal = await h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, h.fixture.nonGit);
    await expect(terminal.page.locator('.xterm-screen')).toBeVisible();
    const marker = join(root, 'shell-starts');
    await expect.poll(() => existsSync(marker) ? readFileSync(marker, 'utf8') : '').toBe('started\n');
  } finally {
    await h.dispose();
  }
  expect(existsSync(root)).toBe(false);
});

test('controller harness owns two independent real terminals and cleans up', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
    await h.launch({ kind: 'development', entry: resolve('out/main/controller.js') }, h.fixture.nonGit);
    const first = await h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, h.fixture.repositories[0]);
    const second = await h.launch({ kind: 'development', entry: resolve('out/main/index.js') }, h.fixture.worktrees[0]);
    for (const [app, dir] of [[first, h.fixture.repositories[0]], [second, h.fixture.worktrees[0]]] as const) {
      expect(await app.app.evaluate(({ app }) => app.getPath('userData'))).toContain(h.fixture.root);
      await expect(app.page.locator('.xterm-rows')).not.toHaveText('');
      await app.page.locator('.xterm-screen').click();
      await app.page.keyboard.type('printf "C1_%s\\n" "$PWD"');
      await app.page.keyboard.press('Enter');
      await expect(app.page.locator('.xterm-rows')).toContainText(`C1_${dir}`);
    }
    expect(first.app.process().pid).not.toBe(second.app.process().pid);
    await expect(h.launch({ kind: 'packaged', executablePath: join(h.fixture.root, 'missing-app') }, h.fixture.nonGit)).rejects.toThrow();
    expect(first.app.process().exitCode).toBeNull();
  } finally {
    await h.dispose();
  }
  expect(existsSync(h.fixture.root)).toBe(false);
});
