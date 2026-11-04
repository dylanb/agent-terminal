import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { getConfig } from 'app-builder-lib/out/util/config/config';
import { resolveLaunchInvocation, CONTROLLER_PRODUCT_NAME, CONTROLLER_OUTPUT_SUBDIR } from '../../src/main/cliShim';

// The launch invocation a fresh instance is started with (§23.4 / #25): the dev-vs-packaged decision
// the shim encodes, tested as a pure function so it is not buried in untested main-process glue.

describe('resolveLaunchInvocation (§23.4 / #25)', () => {
  it('execs the app binary with no extra args for a packaged build', () => {
    expect(resolveLaunchInvocation('/Applications/AgentTerminal', false, undefined, '/work', '/bundle/main')).toEqual({
      execPath: '/Applications/AgentTerminal',
      appArgs: [],
    });
  });

  it('execs Electron with the dev main script, absolutized against the launch cwd', () => {
    expect(resolveLaunchInvocation('/apps/Electron', true, 'out/main/index.js', '/work', '/work/out/main')).toEqual({
      execPath: '/apps/Electron',
      appArgs: ['/work/out/main/index.js'],
      mainDir: '/work/out/main',
    });
  });

  it('passes an already-absolute dev main script through unchanged', () => {
    expect(resolveLaunchInvocation('/apps/Electron', true, '/abs/out/main/index.js', '/work', '/abs/out/main')).toEqual({
      execPath: '/apps/Electron',
      appArgs: ['/abs/out/main/index.js'],
      mainDir: '/abs/out/main',
    });
  });

  it('carries the running main bundle dir when electron-vite dev starts Electron on the app root', () => {
    expect(resolveLaunchInvocation('/apps/Electron', true, '.', '/clone', '/clone/out/main')).toEqual({
      execPath: '/apps/Electron',
      appArgs: ['/clone'],
      mainDir: '/clone/out/main',
    });
  });

  it('omits args when a dev build has no main script', () => {
    expect(resolveLaunchInvocation('/apps/Electron', true, undefined, '/work', '/work/out/main')).toEqual({
      execPath: '/apps/Electron',
      appArgs: [],
    });
  });
});

describe('controller launch names match the packaged controller (§23.5)', () => {
  const root = path.resolve(__dirname, '..', '..');
  const load = (file: string) => getConfig(root, file, null);

  it('looks for the controller binary under the product name the controller is packaged as', async () => {
    expect((await load('electron-builder.controller.yml')).productName).toBe(CONTROLLER_PRODUCT_NAME);
  });

  it('looks for the controller build output where the controller package config writes it', async () => {
    const terminal = await load('electron-builder.yml');
    const controller = await load('electron-builder.controller.yml');
    expect(controller.directories?.output).toBe(
      path.posix.join(terminal.directories?.output ?? '', CONTROLLER_OUTPUT_SUBDIR),
    );
  });
});
