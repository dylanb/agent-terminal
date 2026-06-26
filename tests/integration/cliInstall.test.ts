import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, statSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInstallTarget, installCliShim, type InstallTarget } from '../../src/main/cliInstall';
import { CLI_COMMAND_NAME, type LaunchInvocation } from '../../src/main/cliShim';
import type { CliInstallResult } from '../../src/shared/ipc';

// Installer behavior (§23.4 / #25): drive the real installer through its injected location seam with
// real fs. Assert the OBSERVABLE outcomes the ACs name — runnable from a new shell, idempotent
// reconcile to the current build, and a visible error with no partial-success state.

let root: string;
const inv = (execPath: string): LaunchInvocation => ({ execPath, appArgs: [] });
const isExecutable = (p: string): boolean => (statSync(p).mode & 0o111) !== 0;
const asOk = (res: CliInstallResult): { ok: true; path: string } => {
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(res.error ?? 'expected ok');
  return res;
};
const asErr = (res: CliInstallResult): { ok: false; error?: string } => {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error('expected error');
  return res;
};

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

    const cmd = join(binDir, CLI_COMMAND_NAME);
    expect(asOk(res).path).toBe(cmd);
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
    expect(profileText.match(/agent-terminal launcher >>>/g)?.length).toBe(1);
    expect(profileText.match(/agent-terminal launcher <<</g)?.length).toBe(1);
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
    const text = readFileSync(profile, 'utf8');
    expect(text.match(/agent-terminal launcher >>>/g)?.length).toBe(1);
    expect(text.match(/agent-terminal launcher <<</g)?.length).toBe(1);
  });
});

describe('installCliShim runtime idempotence (no duplicate PATH entry when a profile is sourced twice)', () => {
  it('puts the bin directory on PATH only once even if its profile is sourced repeatedly', () => {
    const binDir = join(root, 'bin');
    const profile = join(root, '.profile');
    writeFileSync(profile, '');
    expect(installCliShim({ binDir, profiles: [profile], currentPath: '/usr/bin', invocation: inv('/app/x') }).ok).toBe(true);

    const out = execFileSync('sh', ['-c', `. "${profile}"; . "${profile}"; printf '%s' "$PATH"`], {
      env: { HOME: root, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    });
    expect(out.split(':').filter((seg) => seg === binDir).length).toBe(1);
  });
});

describe('installCliShim quotes the bin directory in the profile (CWE-78)', () => {
  it('puts a bin directory containing shell metacharacters on PATH literally, with no evaluation', () => {
    const binDir = join(root, 'we ird$dir', 'bin');
    const profile = join(root, '.profile');
    writeFileSync(profile, '');
    const res = installCliShim({ binDir, profiles: [profile], currentPath: '/usr/bin', invocation: inv('/app/x') });
    expect(res.ok).toBe(true);

    const resolved = execFileSync('sh', ['-c', `. "${profile}"; command -v ${CLI_COMMAND_NAME}`], {
      env: { HOME: root, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    }).trim();
    expect(resolved).toBe(join(binDir, CLI_COMMAND_NAME));
  });
});

describe('installCliShim targets the profile the active shell actually sources (§23.4 / #25)', () => {
  const runtime = (shell: string): Parameters<typeof buildInstallTarget>[0] => ({
    home: root,
    shell,
    currentPath: '/usr/bin',
    execPath: '/app/x',
    defaultApp: false,
    cwd: root,
    existingProfiles: [],
  });

  it('writes the launcher into the rc file a fresh zsh sources, never an unsourced .profile', () => {
    const res = installCliShim(buildInstallTarget(runtime('/bin/zsh')));
    expect(res.ok).toBe(true);
    expect(existsSync(join(root, '.zshrc'))).toBe(true);
    expect(existsSync(join(root, '.profile'))).toBe(false);

    const resolved = execFileSync('sh', ['-c', `. "${join(root, '.zshrc')}"; command -v ${CLI_COMMAND_NAME}`], {
      env: { HOME: root, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    }).trim();
    expect(resolved).toBe(join(root, '.agent-terminal', 'bin', CLI_COMMAND_NAME));
  });

  it('reports a visible error for a shell the export block cannot reach (fish), writing no shell profile', () => {
    const res = installCliShim(buildInstallTarget(runtime('/usr/bin/fish')));
    expect(asErr(res).error).toBeTruthy();
    expect(existsSync(join(root, '.zshrc'))).toBe(false);
    expect(existsSync(join(root, '.profile'))).toBe(false);
    expect(existsSync(join(root, '.config', 'fish', 'config.fish'))).toBe(false);
  });
});

describe('installCliShim reconciles orphan blocks across a default-shell change (§23.4 / #25)', () => {
  const runtime = (shell: string, existingProfiles: string[]): Parameters<typeof buildInstallTarget>[0] => ({
    home: root,
    shell,
    currentPath: '/usr/bin',
    execPath: '/app/x',
    defaultApp: false,
    cwd: root,
    existingProfiles,
  });

  it('strips the launcher block from a profile the active shell no longer sources after a shell change', () => {
    const bashrc = join(root, '.bashrc');
    writeFileSync(bashrc, 'export FOO=1\n');
    expect(installCliShim(buildInstallTarget(runtime('/bin/bash', [bashrc]))).ok).toBe(true);
    expect(readFileSync(bashrc, 'utf8')).toContain('agent-terminal launcher');

    expect(installCliShim(buildInstallTarget(runtime('/bin/zsh', [bashrc]))).ok).toBe(true);

    expect(readFileSync(bashrc, 'utf8')).not.toContain('agent-terminal launcher');
    const zshrc = readFileSync(join(root, '.zshrc'), 'utf8');
    expect(zshrc.match(/agent-terminal launcher >>>/g)?.length).toBe(1);
    expect(zshrc.match(/agent-terminal launcher <<</g)?.length).toBe(1);
  });
});

describe('installCliShim error path (no partial-success state)', () => {
  it('reports a visible error when the shim cannot be written', () => {
    const aFile = join(root, 'afile');
    writeFileSync(aFile, 'i am a file\n');
    const binDir = join(aFile, 'bin');
    const res = installCliShim({ binDir, profiles: [join(root, '.profile')], currentPath: '/usr/bin', invocation: inv('/app/x') });
    expect(asErr(res).error).toBeTruthy();
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
    expect(asErr(res).error).toBeTruthy();
  });
});
