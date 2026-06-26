import { describe, it, expect } from 'vitest';
import { buildInstallTarget, type RuntimeInfo } from '../../src/main/cliInstall';

// The install target derived from the running build's launch facts (§23.4 / #25): pure, so the dev vs
// packaged invocation and the profile-fallback choice are provable without an Electron app.
const base: RuntimeInfo = {
  home: '/home/u',
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

  it('targets the existing profiles when any exist', () => {
    const t = buildInstallTarget({ ...base, existingProfiles: ['/home/u/.zshrc', '/home/u/.bashrc'] });
    expect(t.profiles).toEqual(['/home/u/.zshrc', '/home/u/.bashrc']);
  });

  it('falls back to a single .profile when no shell profile exists', () => {
    expect(buildInstallTarget(base).profiles).toEqual(['/home/u/.profile']);
  });

  it('carries the current PATH through for the already-on-PATH check', () => {
    expect(buildInstallTarget(base).currentPath).toBe('/usr/bin:/bin');
  });
});
