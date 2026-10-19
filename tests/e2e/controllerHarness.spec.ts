import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createControllerHarness } from './controllerHarness';

test('controller harness owns two independent real terminals and cleans up', { tag: '@ownapp' }, async () => {
  const h = createControllerHarness();
  try {
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
