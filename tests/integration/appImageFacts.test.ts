import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { appImageFactsFromEnv } from '../../src/main/appImageFacts';
import { resolveLaunchInvocation } from '../../src/main/cliShim';

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'appimage-facts-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const launchFor = (execPath: string, env: NodeJS.ProcessEnv) =>
  resolveLaunchInvocation(execPath, false, undefined, work, work, appImageFactsFromEnv(env));

describe('appImageFactsFromEnv (#306)', () => {
  it('lets the resolver see the running binary inside a mount whose APPDIR reaches it through a symlink', () => {
    const appImage = join(work, 'apps', 'agent-terminal.AppImage');
    const binary = join(work, 'realtmp', '.mount_agentX', 'usr', 'bin', 'agent-terminal');
    mkdirSync(join(binary, '..'), { recursive: true });
    writeFileSync(binary, '');
    symlinkSync(join(work, 'realtmp'), join(work, 'linktmp'));
    const env = { APPIMAGE: appImage, APPDIR: join(work, 'linktmp', '.mount_agentX') };
    expect(launchFor(realpathSync(binary), env)).toEqual({ kind: 'appImage', appImage });
  });

  it.each([
    ['only APPIMAGE', { APPIMAGE: '/home/u/agent-terminal.AppImage' }],
    ['only APPDIR', { APPDIR: '/tmp/.mount_AbC' }],
    ['neither', {}],
  ])('gives no AppImage facts when %s is set', (_what, env) => {
    expect(appImageFactsFromEnv(env)).toBeUndefined();
  });

  it('keeps a relative APPDIR relative, so the resolver still ignores it even when it would resolve around the binary', () => {
    const binary = resolve('tests', 'agent-terminal-app');
    const env = { APPIMAGE: '/home/u/agent-terminal.AppImage', APPDIR: 'tests' };
    expect(launchFor(binary, env)).toEqual({ kind: 'packaged', execPath: binary });
  });

  it('passes an APPDIR that does not exist through as given', () => {
    const appImage = '/home/u/agent-terminal.AppImage';
    const env = { APPIMAGE: appImage, APPDIR: join(work, 'gone', '.mount_AbC') };
    expect(launchFor(join(work, 'gone', '.mount_AbC', 'agent-terminal-app'), env)).toEqual({ kind: 'appImage', appImage });
  });
});
