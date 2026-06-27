import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installCliShim, handleCliInstall, type RuntimeInfo } from '../../src/main/cliInstall';
import { resolveShellPath } from '../../src/main/pty';
import { CLI_COMMAND_NAME, type LaunchInvocation } from '../../src/main/cliShim';
import { SESSION_ID, type CliInstallResult } from '../../src/shared/ipc';

// Installer behavior (§23.4 / #25): drive the real installer through its only public seam — RuntimeInfo,
// the running build's launch facts — with real fs. Assert the OBSERVABLE outcomes the ACs name:
// runnable from a new shell, idempotent reconcile to the current build, and a visible error with no
// partial-success state. Which dotfile is edited is the installer's business, observed only through
// "does the command resolve from a new shell", never by asserting an intermediate target shape.

let root: string;
const inv = (execPath: string): LaunchInvocation => ({ execPath, appArgs: [] });
const binOf = (home: string): string => join(home, '.agent-terminal', 'bin');
const cmdOf = (home: string): string => join(binOf(home), CLI_COMMAND_NAME);
const isExecutable = (p: string): boolean => (statSync(p).mode & 0o111) !== 0;

const runtime = (over: Partial<RuntimeInfo> = {}): RuntimeInfo => ({
  home: root,
  shell: '/bin/sh',
  currentPath: '/usr/bin',
  invocation: inv('/app/x'),
  ...over,
});

/** Resolve `agent-terminal` from a fresh shell that only sourced `profile` — the observable proof
 *  that the install put the command on PATH for a new shell. The profile path is passed as a
 *  positional arg, never interpolated, so a metacharacter in the path is not re-expanded here. */
const resolvesFrom = (profile: string): string =>
  execFileSync('sh', ['-c', `. "$1"; command -v ${CLI_COMMAND_NAME}`, 'sh', profile], {
    env: { HOME: root, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  }).trim();

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
const blockCount = (text: string): number => (text.match(/agent-terminal launcher >>>/g) ?? []).length;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-term-install-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('handleCliInstall (cli:install contract guard, §6 / §23.4)', () => {
  it('installs a runnable command for a valid live-session request', () => {
    const res = handleCliInstall({ sessionId: SESSION_ID }, () => runtime({ shell: '/bin/sh' }));
    expect(asOk(res).path).toBe(cmdOf(root));
    expect(isExecutable(cmdOf(root))).toBe(true);
  });

  it('rejects a wrong-session request with a visible error and performs no install work', () => {
    let gathered = 0;
    const res = handleCliInstall({ sessionId: 'not-the-session' }, () => {
      gathered++;
      return runtime();
    });
    expect(asErr(res).error).toMatch(/invalid/i);
    expect(gathered).toBe(0); // short-circuits before touching the environment
    expect(existsSync(join(root, '.agent-terminal'))).toBe(false); // no partial state on disk
  });

  it('rejects a non-record or missing-session request the same way', () => {
    expect(asErr(handleCliInstall(undefined, () => runtime())).error).toMatch(/invalid/i);
    expect(asErr(handleCliInstall({}, () => runtime())).error).toMatch(/invalid/i);
    expect(existsSync(join(root, '.agent-terminal'))).toBe(false);
  });
});

describe('installCliShim happy path', () => {
  it('writes an executable command that resolves from a new shell after sourcing the profile', () => {
    const res = installCliShim(runtime({ shell: '/bin/sh' }));
    expect(asOk(res).path).toBe(cmdOf(root));
    expect(isExecutable(cmdOf(root))).toBe(true);
    expect(resolvesFrom(join(root, '.profile'))).toBe(cmdOf(root));
  });

  it('does not edit any profile when the bin directory is already on PATH', () => {
    const profile = join(root, '.profile');
    writeFileSync(profile, 'export FOO=1\n');
    const res = installCliShim(runtime({ shell: '/bin/sh', currentPath: `${binOf(root)}:/usr/bin` }));
    expect(res.ok).toBe(true);
    expect(readFileSync(profile, 'utf8')).toBe('export FOO=1\n');
  });
});

describe('installCliShim idempotency (reconcile to the current build)', () => {
  it('reinstalling a different build reconciles the command and never accumulates duplicate entries', () => {
    expect(installCliShim(runtime({ shell: '/bin/sh', invocation: inv('/builds/one/app') })).ok).toBe(true);
    expect(installCliShim(runtime({ shell: '/bin/sh', invocation: inv('/builds/two/app') })).ok).toBe(true);

    const shim = readFileSync(cmdOf(root), 'utf8');
    expect(shim).toContain('/builds/two/app');
    expect(shim).not.toContain('/builds/one/app');
    expect(blockCount(readFileSync(join(root, '.profile'), 'utf8'))).toBe(1);
  });
});

describe('installCliShim resilience to a hand-edited profile', () => {
  it('still installs and adds exactly one complete block when a prior block lost its end marker', () => {
    const profile = join(root, '.profile');
    writeFileSync(profile, '# >>> agent-terminal launcher >>>\nexport PATH="/stale/bin:$PATH"\nexport FOO=1\n');
    expect(installCliShim(runtime({ shell: '/bin/sh' })).ok).toBe(true);

    expect(resolvesFrom(profile)).toBe(cmdOf(root));
    expect(blockCount(readFileSync(profile, 'utf8'))).toBe(1);
    expect(readFileSync(profile, 'utf8')).toContain('agent-terminal launcher <<<');
  });
});

describe('installCliShim runtime idempotence (no duplicate PATH entry when a profile is sourced twice)', () => {
  it('puts the bin directory on PATH only once even if its profile is sourced repeatedly', () => {
    expect(installCliShim(runtime({ shell: '/bin/sh' })).ok).toBe(true);
    const profile = join(root, '.profile');
    const out = execFileSync('sh', ['-c', `. "${profile}"; . "${profile}"; printf '%s' "$PATH"`], {
      env: { HOME: root, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    });
    expect(out.split(':').filter((seg) => seg === binOf(root)).length).toBe(1);
  });
});

describe('installCliShim quotes the bin directory in the profile (CWE-78)', () => {
  it('puts a bin directory containing shell metacharacters on PATH literally, with no evaluation', () => {
    const home = join(root, 'we ird$dir');
    expect(installCliShim(runtime({ home, shell: '/bin/sh' })).ok).toBe(true);
    expect(resolvesFrom(join(home, '.profile'))).toBe(cmdOf(home));
  });
});

describe('installCliShim targets the profile the active shell actually sources (§23.4 / #25)', () => {
  it('writes the launcher into the rc file a fresh zsh sources, never an unsourced .profile', () => {
    expect(installCliShim(runtime({ shell: '/bin/zsh' })).ok).toBe(true);
    expect(existsSync(join(root, '.profile'))).toBe(false);
    expect(resolvesFrom(join(root, '.zshrc'))).toBe(cmdOf(root));
  });

  it('makes the launcher reachable from both an interactive and a login bash shell', () => {
    expect(installCliShim(runtime({ shell: '/bin/bash' })).ok).toBe(true);
    expect(resolvesFrom(join(root, '.bashrc'))).toBe(cmdOf(root)); // interactive
    expect(resolvesFrom(join(root, '.profile'))).toBe(cmdOf(root)); // login
  });

  it('extends an existing bash login profile rather than shadowing it with a new .profile', () => {
    const bashProfile = join(root, '.bash_profile');
    writeFileSync(bashProfile, 'export FOO=1\n');
    expect(installCliShim(runtime({ shell: '/bin/bash' })).ok).toBe(true);
    expect(resolvesFrom(bashProfile)).toBe(cmdOf(root));
    expect(existsSync(join(root, '.profile'))).toBe(false);
  });

  it('reports a visible error for a shell whose new shells the export block cannot reach', () => {
    for (const shell of ['/usr/bin/fish', '']) {
      rmSync(root, { recursive: true, force: true });
      root = mkdtempSync(join(tmpdir(), 'agent-term-install-'));
      expect(asErr(installCliShim(runtime({ shell }))).error).toBeTruthy();
      expect(existsSync(join(root, '.zshrc'))).toBe(false);
      expect(existsSync(join(root, '.profile'))).toBe(false);
    }
  });
});

describe('installCliShim on a GUI/launchd launch with no $SHELL in the env (§23.4 / #25)', () => {
  const guiShell = (loginShell: string | undefined): string =>
    resolveShellPath({} as NodeJS.ProcessEnv, loginShell);

  it("routes the PATH edit to the user's login shell, reachable from a new shell, not the unsupported-shell error", () => {
    const res = installCliShim(runtime({ shell: guiShell('/bin/zsh') }));
    expect(asOk(res).path).toBe(cmdOf(root));
    expect(existsSync(join(root, '.profile'))).toBe(false);
    expect(resolvesFrom(join(root, '.zshrc'))).toBe(cmdOf(root));
  });

  it('still lands a reachable launcher when even the login shell is unknown (bash last resort)', () => {
    const res = installCliShim(runtime({ shell: guiShell(undefined) }));
    expect(asOk(res).path).toBe(cmdOf(root));
    expect(resolvesFrom(join(root, '.profile'))).toBe(cmdOf(root));
  });
});

describe('installCliShim reconciles orphan blocks across a default-shell change (§23.4 / #25)', () => {
  it('strips the launcher block from a profile the active shell no longer sources after a shell change', () => {
    const bashrc = join(root, '.bashrc');
    writeFileSync(bashrc, 'export FOO=1\n');
    expect(installCliShim(runtime({ shell: '/bin/bash' })).ok).toBe(true);
    expect(readFileSync(bashrc, 'utf8')).toContain('agent-terminal launcher');

    expect(installCliShim(runtime({ shell: '/bin/zsh' })).ok).toBe(true);
    expect(readFileSync(bashrc, 'utf8')).not.toContain('agent-terminal launcher');
    expect(blockCount(readFileSync(join(root, '.zshrc'), 'utf8'))).toBe(1);
  });

  it('leaves exactly one block when reinstalling under the same shell whose profile already exists', () => {
    const zshrc = join(root, '.zshrc');
    writeFileSync(zshrc, 'export FOO=1\n');
    const run = (): CliInstallResult => installCliShim(runtime({ shell: '/bin/zsh' }));
    expect(run().ok).toBe(true);
    expect(run().ok).toBe(true);
    expect(blockCount(readFileSync(zshrc, 'utf8'))).toBe(1);
  });
});

describe('installCliShim error path (no partial-success state)', () => {
  it('reports a visible error when the shim cannot be written', () => {
    const home = join(root, 'h');
    mkdirSync(home);
    writeFileSync(join(home, '.agent-terminal'), 'i am a file, not a directory\n');
    const res = installCliShim(runtime({ home, shell: '/bin/sh' }));
    expect(asErr(res).error).toBeTruthy();
    expect(existsSync(binOf(home))).toBe(false);
  });

  it('reports a visible error when it can write the shim but cannot extend PATH', () => {
    const home = join(root, 'h');
    mkdirSync(home);
    mkdirSync(join(home, '.profile')); // a directory where a profile file is expected → writes fail
    const res = installCliShim(runtime({ home, shell: '/bin/sh' }));
    expect(asErr(res).error).toBeTruthy();
  });
});
