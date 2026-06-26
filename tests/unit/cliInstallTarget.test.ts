import { describe, it, expect } from 'vitest';
import { buildInstallTarget, type RuntimeInfo } from '../../src/main/cliInstall';

// The install target derived from the running build's launch facts (§23.4 / #25): pure, so the dev vs
// packaged invocation and the shell-aware profile choice are provable without an Electron app.
const base: RuntimeInfo = {
  home: '/home/u',
  shell: '/bin/zsh',
  currentPath: '/usr/bin:/bin',
  execPath: '/apps/Electron',
  defaultApp: false,
  cwd: '/work',
  existingProfiles: [],
};

describe('buildInstallTarget (§23.4 / #25)', () => {
  it('roots the bin directory under the user home', () => {
    expect(buildInstallTarget(base).binDir).toBe('/home/u/.agent-terminal/bin');
  });

  it('embeds the main script (resolved against cwd) as a launch arg in a dev build', () => {
    const t = buildInstallTarget({ ...base, defaultApp: true, mainScript: 'out/main/index.js' });
    expect(t.invocation).toEqual({ execPath: '/apps/Electron', appArgs: ['/work/out/main/index.js'] });
  });

  it('embeds no launch args in a packaged build', () => {
    const t = buildInstallTarget({ ...base, defaultApp: false, mainScript: undefined });
    expect(t.invocation.appArgs).toEqual([]);
  });

  it('targets only the profiles the active shell sources, ignoring foreign dotfiles', () => {
    const t = buildInstallTarget({
      ...base,
      shell: '/bin/zsh',
      existingProfiles: ['/home/u/.zshrc', '/home/u/.bashrc', '/home/u/.profile'],
    });
    expect(t.profiles).toEqual(['/home/u/.zshrc']);
  });

  it('creates the shell rc file zsh sources when no zsh profile exists, not .profile', () => {
    const t = buildInstallTarget({ ...base, shell: '/usr/bin/zsh', existingProfiles: [] });
    expect(t.profiles).toEqual(['/home/u/.zshrc']);
  });

  it('covers both interactive and login bash profiles when none exist yet', () => {
    const t = buildInstallTarget({ ...base, shell: '/bin/bash', existingProfiles: [] });
    expect(t.profiles).toEqual(['/home/u/.bashrc', '/home/u/.profile']);
  });

  it('writes only the existing bash login profile rather than shadowing it with a new one', () => {
    const t = buildInstallTarget({
      ...base,
      shell: '/bin/bash',
      existingProfiles: ['/home/u/.bashrc', '/home/u/.profile'],
    });
    expect(t.profiles).toEqual(['/home/u/.bashrc', '/home/u/.profile']);
  });

  it('targets .profile for a plain POSIX shell (sh and dash)', () => {
    expect(buildInstallTarget({ ...base, shell: '/bin/sh', existingProfiles: [] }).profiles).toEqual(['/home/u/.profile']);
    expect(buildInstallTarget({ ...base, shell: '/usr/bin/dash', existingProfiles: [] }).profiles).toEqual(['/home/u/.profile']);
  });

  it('yields no profiles for a shell the POSIX export block cannot reach (fish)', () => {
    expect(buildInstallTarget({ ...base, shell: '/usr/bin/fish', existingProfiles: [] }).profiles).toEqual([]);
  });

  it('yields no profiles for an unknown or empty shell', () => {
    expect(buildInstallTarget({ ...base, shell: '', existingProfiles: [] }).profiles).toEqual([]);
  });

  it('carries the current PATH through for the already-on-PATH check', () => {
    expect(buildInstallTarget(base).currentPath).toBe('/usr/bin:/bin');
  });
});
