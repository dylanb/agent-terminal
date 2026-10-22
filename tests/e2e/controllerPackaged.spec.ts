import { shellQuote } from '../../src/shared/shellQuote';
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveWindowIconPath } from '../../src/main/appIcon';
import { createControllerDesktopHarness } from './controllerDesktop';
import { typeAtDesktop } from './controllerKeyboard';

const PACKAGE_BUILD_MS = 180_000;

test('packaged controller identifies and activates independent packaged terminals outside the checkout', { tag: '@ownapp' }, async () => {
  test.setTimeout(PACKAGE_BUILD_MS + 120_000);
  execFileSync('pnpm', ['exec', 'electron-builder', '--dir', '--config.npmRebuild=false'], { timeout: PACKAGE_BUILD_MS, stdio: 'inherit' });
  execFileSync('pnpm', ['exec', 'electron-builder', '--dir', '--config', 'electron-builder.controller.yml', '--config.npmRebuild=false'], { timeout: PACKAGE_BUILD_MS, stdio: 'inherit' });
  const h = await createControllerDesktopHarness();
  const install = (output: string, name: string) => {
    const directory = process.platform === 'darwin'
      ? `mac${process.arch === 'arm64' ? '-arm64' : ''}`
      : `linux${process.arch === 'arm64' ? '-arm64' : ''}-unpacked`;
    const destination = join(h.fixture.root, name);
    cpSync(resolve(output, directory), destination, { recursive: true, verbatimSymlinks: true });
    return process.platform === 'darwin'
      ? join(destination, `${name}.app`, 'Contents', 'MacOS', name)
      : join(destination, name);
  };
  try {
    const controllerExecutable = install('dist/controller', 'agent-terminal-controller');
    const terminalExecutable = install('dist', 'agent-terminal');
    const resources = (executable: string) => process.platform === 'darwin'
      ? resolve(executable, '..', '..', 'Resources')
      : resolve(executable, '..', 'resources');
    const committedIcon = readFileSync(resolveWindowIconPath({ packaged: false, appPath: process.cwd() }, 'controller'));
    expect(readFileSync(resolveWindowIconPath({ packaged: true, resourcesPath: resources(controllerExecutable) }, 'controller')))
      .toEqual(committedIcon);
    if (process.platform === 'darwin') {
      const bundleIcon = (executable: string) => readFileSync(join(resources(executable), 'icon.icns'));
      expect(bundleIcon(controllerExecutable).equals(bundleIcon(terminalExecutable))).toBe(false);
    }
    const controller = await h.launch({ kind: 'packaged', executablePath: controllerExecutable }, h.fixture.nonGit);
    const controllerArchive = await controller.app.evaluate(({ app }) => app.getAppPath());
    const terminals = await Promise.all(h.fixture.repositories.map(directory =>
      h.launch({ kind: 'packaged', executablePath: terminalExecutable }, directory)));
    for (const application of [controller, ...terminals]) {
      expect(await application.app.evaluate(({ app }) => app.isPackaged)).toBe(true);
      expect(await application.app.evaluate(({ app }) => app.getAppPath())).toContain(h.fixture.root);
    }
    for (const [index, directory] of h.fixture.repositories.entries()) {
      await expect(controller.page.getByRole('button', { name: directory, exact: false })).toHaveCount(1);
      await terminals[index].page.locator('.xterm-screen').click();
      await terminals[index].app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
      typeAtDesktop(`printf 'PACKAGED_READY_%s\\n' ${shellQuote(String(index))}`, h.fixture.env);
      await expect(terminals[index].page.locator('.xterm-rows')).toContainText(`PACKAGED_READY_${index}`);
      await terminals[index].app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await expect.poll(() => terminals[index].app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
    }
    for (const [index, directory] of h.fixture.repositories.entries()) {
      await controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
      await expect.poll(() => controller.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
      await controller.page.getByRole('button', { name: directory, exact: false }).click();
      await expect.soft.poll(() => terminals[index].app.evaluate(({ BrowserWindow }) => ({
        minimized: BrowserWindow.getAllWindows()[0].isMinimized(), focused: BrowserWindow.getAllWindows()[0].isFocused(),
      }))).toEqual({ minimized: false, focused: true });
      typeAtDesktop(`printf 'PACKAGED_TARGET_%s\\n' ${shellQuote(String(index))}`, h.fixture.env);
      await expect.soft(terminals[index].page.locator('.xterm-rows')).toContainText(`PACKAGED_TARGET_${index}`);
      await expect.soft(terminals[1 - index].page.locator('.xterm-rows')).not.toContainText(`PACKAGED_TARGET_${index}`);
    }
    await controller.app.close();
    for (const [index, terminal] of terminals.entries()) {
      await terminal.app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.restore(); window.focus(); });
      await terminal.page.locator('.xterm-screen').click();
      typeAtDesktop(`printf 'PACKAGED_AFTER_QUIT_%s\\n' ${shellQuote(String(index))}`, h.fixture.env);
      await expect(terminal.page.locator('.xterm-rows')).toContainText(`PACKAGED_AFTER_QUIT_${index}`);
    }
    for (const runtime of ['missing', 'corrupt'] as const) {
      if (runtime === 'missing') rmSync(controllerArchive);
      else writeFileSync(controllerArchive, 'not an Electron archive');
      await expect.soft(h.launch({ kind: 'packaged', executablePath: controllerExecutable }, h.fixture.nonGit))
        .rejects.toThrow(/Failed to launch|Process failed to launch|Unable to find Electron app|Cannot find module/);
    }
  } finally { await h.dispose(); }
});
