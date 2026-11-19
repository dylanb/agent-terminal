import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { getConfig } from 'app-builder-lib/out/util/config/config';
import { effectiveLinuxExecutableName, effectiveLinuxDesktopFileName } from '../helpers/linuxExecutableName';
import { resolveLaunchInvocation, CONTROLLER_PRODUCT_NAME, CONTROLLER_OUTPUT_SUBDIR, CLI_COMMAND_NAME, TERMINAL_APPIMAGE_PREFIX } from '../../src/main/cliShim';

// The launch invocation a fresh instance is started with (§23.4 / #25): the dev-vs-packaged decision
// the shim encodes, tested as a pure function so it is not buried in untested main-process glue.

describe('resolveLaunchInvocation (§23.4 / #25)', () => {
  it('execs the app binary with no extra args for a packaged build', () => {
    expect(resolveLaunchInvocation('/Applications/AgentTerminal', false, undefined, '/work', '/bundle/main')).toEqual({
      kind: 'packaged',
      execPath: '/Applications/AgentTerminal',
    });
  });

  it('execs Electron with the dev start path, absolutized against the launch cwd', () => {
    expect(resolveLaunchInvocation('/apps/Electron', true, 'out/main/index.js', '/work', '/work/out/main')).toEqual({
      kind: 'development',
      execPath: '/apps/Electron',
      startPath: '/work/out/main/index.js',
      mainDir: '/work/out/main',
    });
  });

  it('passes an already-absolute dev start path through unchanged', () => {
    expect(resolveLaunchInvocation('/apps/Electron', true, '/abs/out/main/index.js', '/work', '/abs/out/main')).toEqual({
      kind: 'development',
      execPath: '/apps/Electron',
      startPath: '/abs/out/main/index.js',
      mainDir: '/abs/out/main',
    });
  });

  it('carries the running main bundle dir when electron-vite dev starts Electron on the app root', () => {
    expect(resolveLaunchInvocation('/apps/Electron', true, '.', '/clone', '/clone/out/main')).toEqual({
      kind: 'development',
      execPath: '/apps/Electron',
      startPath: '/clone',
      mainDir: '/clone/out/main',
    });
  });

  it('launches like a packaged build when a dev build has no start path', () => {
    expect(resolveLaunchInvocation('/apps/Electron', true, undefined, '/work', '/work/out/main')).toEqual({
      kind: 'packaged',
      execPath: '/apps/Electron',
    });
  });
});

describe('resolveLaunchInvocation inside an AppImage mount (#306)', () => {
  const appImage = '/home/u/Apps/agent-terminal.AppImage';
  const mountDir = '/tmp/.mount_AbC';
  const facts = { appImage, mountDir };

  it('launches the AppImage file when the running binary lives under its mount', () => {
    expect(resolveLaunchInvocation('/tmp/.mount_AbC/agent-terminal-app', false, undefined, '/work', '/work/out/main', facts)).toEqual({
      kind: 'appImage',
      appImage,
    });
  });

  it('launches the AppImage file for a dev-build call inside the mount, with no app args', () => {
    expect(resolveLaunchInvocation('/tmp/.mount_AbC/agent-terminal-app', true, 'out/main/index.js', '/work', '/work/out/main', facts)).toEqual({
      kind: 'appImage',
      appImage,
    });
  });

  it('keeps the packaged result when the binary is outside the mount (the mount facts were inherited)', () => {
    expect(resolveLaunchInvocation('/opt/agent-terminal/agent-terminal-app', false, undefined, '/work', '/work/out/main', facts)).toEqual({
      kind: 'packaged',
      execPath: '/opt/agent-terminal/agent-terminal-app',
    });
  });

  it('keeps the dev result when a dev build runs outside the mount', () => {
    expect(resolveLaunchInvocation('/apps/Electron', true, 'out/main/index.js', '/work', '/work/out/main', facts)).toEqual({
      kind: 'development',
      execPath: '/apps/Electron',
      startPath: '/work/out/main/index.js',
      mainDir: '/work/out/main',
    });
  });

  it('does not treat a sibling folder sharing the mount name as a prefix as inside the mount', () => {
    expect(resolveLaunchInvocation('/tmp/.mount_AbCD/x', false, undefined, '/work', '/work/out/main', facts)).toEqual({
      kind: 'packaged',
      execPath: '/tmp/.mount_AbCD/x',
    });
  });

  it('keeps the packaged result when the AppImage path is relative', () => {
    expect(
      resolveLaunchInvocation('/tmp/.mount_AbC/agent-terminal-app', false, undefined, '/work', '/work/out/main', {
        appImage: 'Apps/agent-terminal.AppImage',
        mountDir,
      }),
    ).toEqual({ kind: 'packaged', execPath: '/tmp/.mount_AbC/agent-terminal-app' });
  });

  it('keeps the packaged result when the mount path is relative, even one that resolves around the binary', () => {
    const insideRelativeMount = path.resolve('.mount_AbC', 'agent-terminal-app');
    expect(
      resolveLaunchInvocation(insideRelativeMount, false, undefined, '/work', '/work/out/main', {
        appImage,
        mountDir: '.mount_AbC',
      }),
    ).toEqual({ kind: 'packaged', execPath: insideRelativeMount });
  });
});

describe('controller launch names match the packaged controller (§23.5)', () => {
  const root = path.resolve(__dirname, '..', '..');
  const load = (file: string) => getConfig(root, file, null);

  it('looks for the controller binary under the product name the controller is packaged as', async () => {
    expect((await load('electron-builder.controller.yml')).productName).toBe(CONTROLLER_PRODUCT_NAME);
  });

  it('derives the controller AppImage from the prefix the terminal AppImage is packaged under', async () => {
    expect((await load('electron-builder.yml')).productName).toBe(TERMINAL_APPIMAGE_PREFIX);
  });

  it('looks for the controller build output where the controller package config writes it', async () => {
    const terminal = await load('electron-builder.yml');
    const controller = await load('electron-builder.controller.yml');
    expect(controller.directories?.output).toBe(
      path.posix.join(terminal.directories?.output ?? '', CONTROLLER_OUTPUT_SUBDIR),
    );
  });

  it('installs the terminal under a Linux executable name that is not the installed command name', async () => {
    expect(effectiveLinuxExecutableName(await load('electron-builder.yml'))).not.toBe(CLI_COMMAND_NAME);
  });

  it('installs the controller under the Linux executable name it is packaged as', async () => {
    expect(effectiveLinuxExecutableName(await load('electron-builder.controller.yml'))).toBe(CONTROLLER_PRODUCT_NAME);
  });

  it('gives the two packages different desktop file names so both .debs install together', async () => {
    expect(effectiveLinuxDesktopFileName(await load('electron-builder.controller.yml'))).not.toBe(
      effectiveLinuxDesktopFileName(await load('electron-builder.yml')),
    );
  });
});
