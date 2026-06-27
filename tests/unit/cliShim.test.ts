import { describe, it, expect } from 'vitest';
import { resolveLaunchInvocation } from '../../src/main/cliShim';

// The launch invocation a fresh instance is started with (§23.4 / #25): the dev-vs-packaged decision
// the shim encodes, tested as a pure function so it is not buried in untested main-process glue.

describe('resolveLaunchInvocation (§23.4 / #25)', () => {
  it('execs the app binary with no extra args for a packaged build', () => {
    expect(resolveLaunchInvocation('/Applications/AgentTerminal', false, undefined, '/work')).toEqual({
      execPath: '/Applications/AgentTerminal',
      appArgs: [],
    });
  });

  it('execs Electron with the dev main script, absolutized against the launch cwd', () => {
    expect(resolveLaunchInvocation('/apps/Electron', true, 'out/main/index.js', '/work')).toEqual({
      execPath: '/apps/Electron',
      appArgs: ['/work/out/main/index.js'],
    });
  });

  it('passes an already-absolute dev main script through unchanged', () => {
    expect(resolveLaunchInvocation('/apps/Electron', true, '/abs/out/main/index.js', '/work')).toEqual({
      execPath: '/apps/Electron',
      appArgs: ['/abs/out/main/index.js'],
    });
  });

  it('omits args when a dev build has no main script', () => {
    expect(resolveLaunchInvocation('/apps/Electron', true, undefined, '/work')).toEqual({
      execPath: '/apps/Electron',
      appArgs: [],
    });
  });
});
