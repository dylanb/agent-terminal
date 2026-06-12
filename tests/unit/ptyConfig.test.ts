import { describe, expect, it } from 'vitest';
import { buildSpawnConfig } from '../../src/main/pty';

const HOME = '/home/u';

describe('buildSpawnConfig (§5)', () => {
  it('Linux: plain interactive bash (sources ~/.bashrc), no -l', () => {
    const cfg = buildSpawnConfig({ platform: 'linux', env: { HOME }, home: HOME });
    expect(cfg.shellPath).toBe('bash');
    expect(cfg.shellArgs).toEqual([]);
  });

  it('macOS: login shell (sources ~/.bash_profile), -l', () => {
    const cfg = buildSpawnConfig({ platform: 'darwin', env: { HOME }, home: HOME });
    expect(cfg.shellPath).toBe('bash');
    expect(cfg.shellArgs).toEqual(['-l']);
  });

  it('APP_SHELL overrides the shell path', () => {
    const cfg = buildSpawnConfig({
      platform: 'linux',
      env: { HOME, APP_SHELL: '/opt/homebrew/bin/bash' },
      home: HOME,
    });
    expect(cfg.shellPath).toBe('/opt/homebrew/bin/bash');
  });

  it('advertises xterm-256color and truecolor on top of the inherited env', () => {
    const cfg = buildSpawnConfig({
      platform: 'linux',
      env: { HOME, LANG: 'en_US.UTF-8', PATH: '/usr/bin' },
      home: HOME,
    });
    expect(cfg.options.name).toBe('xterm-256color');
    expect(cfg.options.env.TERM).toBe('xterm-256color');
    expect(cfg.options.env.COLORTERM).toBe('truecolor');
    expect(cfg.options.env.LANG).toBe('en_US.UTF-8');
    expect(cfg.options.env.PATH).toBe('/usr/bin');
  });

  it('starts in the user home directory', () => {
    const cfg = buildSpawnConfig({ platform: 'linux', env: { HOME }, home: HOME });
    expect(cfg.options.cwd).toBe(HOME);
  });

  it('seeds PATH from a login-shell probe when provided (GUI launch, §5)', () => {
    const cfg = buildSpawnConfig({
      platform: 'linux',
      env: { HOME, PATH: '/usr/bin' },
      home: HOME,
      probedPath: '/home/u/.local/bin:/usr/bin',
    });
    expect(cfg.options.env.PATH).toBe('/home/u/.local/bin:/usr/bin');
  });
});
