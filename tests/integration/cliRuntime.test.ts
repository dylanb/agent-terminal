import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliRuntime, type CliHost } from '../../src/main/cliRuntime';
import { installCliShim } from '../../src/main/cliInstall';
import { CLI_COMMAND_NAME } from '../../src/main/cliShim';

const isRoot = process.getuid?.() === 0;

let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'agent-term-runtime-')));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const host = (over: Partial<CliHost> = {}): CliHost => ({
  env: { PATH: '/usr/bin' },
  home,
  user: { uid: statSync(home).uid, shell: '/bin/sh' },
  execPath: '/app/x',
  isDevBuild: false,
  mainScript: undefined,
  cwd: '/',
  mainDir: '/app/out/main',
  ...over,
});

const localBin = (): string => {
  const lbin = join(home, '.local', 'bin');
  mkdirSync(lbin, { recursive: true });
  chmodSync(join(home, '.local'), 0o755);
  chmodSync(lbin, 0o755);
  return lbin;
};

describe('cliRuntime: the install runs as the OS user it is given', () => {
  it('reuses an on-PATH ~/.local/bin that the given user owns', () => {
    const lbin = localBin();
    const res = installCliShim(cliRuntime(host({ env: { PATH: `${lbin}:/usr/bin` } })));
    expect(res).toEqual({ ok: true, path: join(lbin, CLI_COMMAND_NAME) });
  });

  it.skipIf(isRoot)('does not reuse an on-PATH ~/.local/bin when the given user does not own it', () => {
    const lbin = localBin();
    const res = installCliShim(
      cliRuntime(host({ env: { PATH: `${lbin}:/usr/bin` }, user: { uid: statSync(lbin).uid + 1, shell: '/bin/sh' } })),
    );
    expect(res).toEqual({ ok: true, path: join(home, '.agent-terminal', 'bin', CLI_COMMAND_NAME) });
    expect(existsSync(join(lbin, CLI_COMMAND_NAME))).toBe(false);
  });
});

describe('cliRuntime: an AppImage launch', () => {
  let base: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(homedir(), '.agent-terminal-test-')));
    chmodSync(base, 0o700);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  const appImageHost = (uid: number): CliHost => {
    const apps = join(base, 'apps');
    const appImage = join(apps, 'agent-terminal.AppImage');
    const mountDir = join(base, 'mnt', '.mount_agentX');
    const execPath = join(mountDir, 'usr', 'bin', 'agent-terminal-app');
    for (const f of [appImage, execPath]) {
      mkdirSync(join(f, '..'), { recursive: true });
      writeFileSync(f, '#!/bin/sh\n');
      chmodSync(f, 0o755);
    }
    chmodSync(apps, 0o755);
    return host({ env: { PATH: '/usr/bin', APPIMAGE: appImage, APPDIR: mountDir }, execPath, user: { uid, shell: '/bin/sh' } });
  };

  it('installs a command for the AppImage named in the environment when the given user owns it', () => {
    const res = installCliShim(cliRuntime(appImageHost(statSync(base).uid)));
    expect(res.ok).toBe(true);
  });

  it.skipIf(isRoot)('refuses the AppImage named in the environment when the given user does not own its folder', () => {
    const res = installCliShim(cliRuntime(appImageHost(statSync(base).uid + 1)));
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error ?? '').toContain(join(base, 'apps'));
  });
});
