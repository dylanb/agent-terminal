import { describe, expect, it } from 'vitest';
import { buildSpawnConfig, mergePaths } from '../../src/main/pty';

const HOME = '/home/u';

describe('mergePaths (§5 — GUI-launch PATH probe must not clobber the inherited env)', () => {
  it('appends probed-only entries after the inherited ones, preserving precedence', () => {
    expect(mergePaths('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin')).toBe(
      '/usr/bin:/bin:/opt/homebrew/bin',
    );
  });

  it('keeps inherited-only entries (e.g. an active venv) that the probe lacks', () => {
    expect(mergePaths('/venv/bin:/usr/bin', '/usr/bin')).toBe('/venv/bin:/usr/bin');
  });

  it('never duplicates an entry', () => {
    expect(mergePaths('/usr/bin', '/usr/bin')).toBe('/usr/bin');
  });

  it('falls back to the probed path when nothing is inherited', () => {
    expect(mergePaths('', '/usr/bin:/bin')).toBe('/usr/bin:/bin');
  });

  it('ignores empty segments', () => {
    expect(mergePaths('/usr/bin:', ':/opt/bin')).toBe('/usr/bin:/opt/bin');
  });
});

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

const SCRIPT = '/app/out/main/shell-integration.bash';

describe('shell-integration hook (§15.5 / D3 — PROMPT_COMMAND env seam, opt-out)', () => {
  it('injects the PROMPT_COMMAND source hook when enabled and the shell is bash', () => {
    const cfg = buildSpawnConfig({
      platform: 'linux',
      env: { HOME },
      home: HOME,
      integrationScriptPath: SCRIPT,
    });
    expect(cfg.options.env.APP_TERM_INTEGRATION).toBe(SCRIPT);
    expect(cfg.options.env.PROMPT_COMMAND).toContain('source');
    expect(cfg.options.env.PROMPT_COMMAND).toContain(SCRIPT);
  });

  it('omits the hook when APP_SHELL_INTEGRATION=0', () => {
    const cfg = buildSpawnConfig({
      platform: 'linux',
      env: { HOME, APP_SHELL_INTEGRATION: '0' },
      home: HOME,
      integrationScriptPath: SCRIPT,
    });
    expect(cfg.options.env.APP_TERM_INTEGRATION).toBeUndefined();
    expect(cfg.options.env.PROMPT_COMMAND).toBeUndefined();
  });

  it('omits the hook for a non-bash APP_SHELL', () => {
    const cfg = buildSpawnConfig({
      platform: 'linux',
      env: { HOME, APP_SHELL: '/bin/zsh' },
      home: HOME,
      integrationScriptPath: SCRIPT,
    });
    expect(cfg.options.env.APP_TERM_INTEGRATION).toBeUndefined();
  });

  it('omits the hook when no script path is provided', () => {
    const cfg = buildSpawnConfig({ platform: 'linux', env: { HOME }, home: HOME });
    expect(cfg.options.env.APP_TERM_INTEGRATION).toBeUndefined();
  });
});
