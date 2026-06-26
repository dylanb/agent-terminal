import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, statSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCliShim, type InstallTarget } from '../../src/main/cliInstall';
import { CLI_COMMAND_NAME, type LaunchInvocation } from '../../src/main/cliShim';

// Installer behavior (§23.4 / #25): drive the real installer through its injected location seam with
// real fs. Assert the OBSERVABLE outcomes the ACs name — runnable from a new shell, idempotent
// reconcile to the current build, and a visible error with no partial-success state.

let root: string;
const inv = (execPath: string): LaunchInvocation => ({ execPath, appArgs: [] });
const isExecutable = (p: string): boolean => (statSync(p).mode & 0o111) !== 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-term-install-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('installCliShim happy path', () => {
  it('writes an executable command that resolves from a new shell after sourcing the profile', () => {
    const binDir = join(root, 'bin');
    const profile = join(root, '.profile');
    writeFileSync(profile, 'export FOO=1\n');
    const res = installCliShim({ binDir, profiles: [profile], currentPath: '/usr/bin', invocation: inv('/app/x') });

    expect(res.ok).toBe(true);
    const cmd = join(binDir, CLI_COMMAND_NAME);
    expect(res.path).toBe(cmd);
    expect(isExecutable(cmd)).toBe(true);

    const resolved = execFileSync('sh', ['-c', `. "${profile}"; command -v ${CLI_COMMAND_NAME}`], {
      env: { HOME: root, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    }).trim();
    expect(resolved).toBe(cmd);
  });

  it('does not edit any profile when the bin directory is already on PATH', () => {
    const binDir = join(root, 'bin');
    const profile = join(root, '.profile');
    writeFileSync(profile, 'export FOO=1\n');
    const res = installCliShim({
      binDir,
      profiles: [profile],
      currentPath: `${binDir}:/usr/bin`,
      invocation: inv('/app/x'),
    });
    expect(res.ok).toBe(true);
    expect(readFileSync(profile, 'utf8')).toBe('export FOO=1\n');
  });
});

describe('installCliShim idempotency (reconcile to the current build)', () => {
  it('reinstalling a different build reconciles the command and never accumulates duplicate entries', () => {
    const binDir = join(root, 'bin');
    const profile = join(root, '.profile');
    const target = (execPath: string): InstallTarget => ({
      binDir,
      profiles: [profile],
      currentPath: '/usr/bin',
      invocation: inv(execPath),
    });

    expect(installCliShim(target('/builds/one/app')).ok).toBe(true);
    expect(installCliShim(target('/builds/two/app')).ok).toBe(true);

    const cmd = join(binDir, CLI_COMMAND_NAME);
    const shim = readFileSync(cmd, 'utf8');
    expect(shim).toContain('/builds/two/app');
    expect(shim).not.toContain('/builds/one/app');

    const profileText = readFileSync(profile, 'utf8');
    expect(profileText.match(new RegExp(binDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length).toBe(1);
  });
});

describe('installCliShim resilience to a hand-edited profile', () => {
  it('still installs and adds exactly one complete block when a prior block lost its end marker', () => {
    const binDir = join(root, 'bin');
    const profile = join(root, '.profile');
    writeFileSync(profile, '# >>> agent-terminal launcher >>>\nexport PATH="/stale/bin:$PATH"\nexport FOO=1\n');
    const res = installCliShim({ binDir, profiles: [profile], currentPath: '/usr/bin', invocation: inv('/app/x') });
    expect(res.ok).toBe(true);

    const resolved = execFileSync('sh', ['-c', `. "${profile}"; command -v ${CLI_COMMAND_NAME}`], {
      env: { HOME: root, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    }).trim();
    expect(resolved).toBe(join(binDir, CLI_COMMAND_NAME));
    expect(readFileSync(profile, 'utf8').match(/agent-terminal launcher <<</g)?.length).toBe(1);
  });
});

describe('installCliShim error path (no partial-success state)', () => {
  it('reports a visible error when the shim cannot be written', () => {
    const aFile = join(root, 'afile');
    writeFileSync(aFile, 'i am a file\n');
    const binDir = join(aFile, 'bin');
    const res = installCliShim({ binDir, profiles: [join(root, '.profile')], currentPath: '/usr/bin', invocation: inv('/app/x') });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    expect(existsSync(binDir)).toBe(false);
  });

  it('reports a visible error when it can write the shim but cannot extend PATH', () => {
    const binDir = join(root, 'bin');
    const aFile = join(root, 'afile');
    writeFileSync(aFile, 'i am a file\n');
    const unwritableProfile = join(aFile, '.profile');
    const res = installCliShim({
      binDir,
      profiles: [unwritableProfile],
      currentPath: '/usr/bin',
      invocation: inv('/app/x'),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
