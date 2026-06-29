import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, statSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
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

describe('installCliShim prefers a writable user bin dir already on PATH (§23.4 / #25)', () => {
  const localBin = (home: string): string => join(home, '.local', 'bin');
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it('installs into ~/.local/bin and edits no profile when it is writable and already on PATH', () => {
    const lbin = localBin(root);
    mkdirSync(lbin, { recursive: true });
    chmodSync(join(root, '.local'), 0o755); // pin the dir AND the walked parent so the fixture does not depend on umask
    chmodSync(lbin, 0o755);
    const res = installCliShim(runtime({ shell: '/bin/zsh', currentPath: `${lbin}:/usr/bin` }));
    expect(asOk(res).path).toBe(join(lbin, CLI_COMMAND_NAME));
    expect(isExecutable(join(lbin, CLI_COMMAND_NAME))).toBe(true);
    expect(existsSync(join(root, '.zshrc'))).toBe(false); // already on PATH → no profile edit
    expect(existsSync(binOf(root))).toBe(false); // and no dedicated dir created
  });

  it('leaves the reused directory permissions untouched — it is the user dir, not app-owned', () => {
    const lbin = localBin(root);
    mkdirSync(lbin, { recursive: true });
    chmodSync(join(root, '.local'), 0o755); // pin the walked parent so reuse is selected regardless of umask
    chmodSync(lbin, 0o755);
    expect(installCliShim(runtime({ shell: '/bin/zsh', currentPath: `${lbin}:/usr/bin` })).ok).toBe(true);
    expect(statSync(lbin).mode & 0o777).toBe(0o755); // not tightened to 0o700 like the app-owned dir
  });

  it('prefers ~/.local/bin over ~/bin when both are writable and on PATH', () => {
    const lbin = localBin(root);
    const hbin = join(root, 'bin');
    mkdirSync(lbin, { recursive: true });
    mkdirSync(hbin, { recursive: true });
    chmodSync(join(root, '.local'), 0o755); // pin the dirs AND the walked .local parent so the fixture does not depend on umask
    chmodSync(lbin, 0o755);
    chmodSync(hbin, 0o755);
    const res = installCliShim(runtime({ shell: '/bin/zsh', currentPath: `${hbin}:${lbin}:/usr/bin` }));
    expect(asOk(res).path).toBe(join(lbin, CLI_COMMAND_NAME));
  });

  it('falls back to the dedicated dir + profile edit when the preferred dir is writable but not on PATH', () => {
    const lbin = localBin(root);
    mkdirSync(lbin, { recursive: true });
    const res = installCliShim(runtime({ shell: '/bin/zsh', currentPath: '/usr/bin' }));
    expect(asOk(res).path).toBe(cmdOf(root));
    expect(existsSync(join(lbin, CLI_COMMAND_NAME))).toBe(false);
    expect(resolvesFrom(join(root, '.zshrc'))).toBe(cmdOf(root));
  });

  it.skipIf(isRoot)('falls back to the dedicated dir when the preferred dir is on PATH but not writable', () => {
    const lbin = localBin(root);
    mkdirSync(lbin, { recursive: true });
    chmodSync(lbin, 0o500); // read/execute only — cannot create a file
    try {
      const res = installCliShim(runtime({ shell: '/bin/zsh', currentPath: `${lbin}:/usr/bin` }));
      expect(asOk(res).path).toBe(cmdOf(root));
      expect(resolvesFrom(join(root, '.zshrc'))).toBe(cmdOf(root));
    } finally {
      chmodSync(lbin, 0o700); // restore so afterEach can remove it
    }
  });

  it('strips a stale launcher block from profiles when it switches to an on-PATH dir (no orphans)', () => {
    expect(installCliShim(runtime({ shell: '/bin/zsh' })).ok).toBe(true); // prior dedicated-dir install
    expect(readFileSync(join(root, '.zshrc'), 'utf8')).toContain('agent-terminal launcher');
    const lbin = localBin(root);
    mkdirSync(lbin, { recursive: true });
    chmodSync(join(root, '.local'), 0o755); // pin the dir AND the walked parent so the fixture does not depend on umask
    chmodSync(lbin, 0o755);
    expect(installCliShim(runtime({ shell: '/bin/zsh', currentPath: `${lbin}:/usr/bin` })).ok).toBe(true);
    expect(readFileSync(join(root, '.zshrc'), 'utf8')).not.toContain('agent-terminal launcher');
  });

  it.skipIf(isRoot)('falls back to the hardened dedicated dir when the preferred dir is group/other-writable (CWE-276/426)', () => {
    const lbin = localBin(root);
    mkdirSync(lbin, { recursive: true });
    chmodSync(lbin, 0o777); // world-writable: another local user could substitute the on-PATH launcher
    try {
      const res = installCliShim(runtime({ shell: '/bin/zsh', currentPath: `${lbin}:/usr/bin` }));
      expect(asOk(res).path).toBe(cmdOf(root)); // not the unprotected on-PATH dir
      expect(existsSync(join(lbin, CLI_COMMAND_NAME))).toBe(false);
      expect(resolvesFrom(join(root, '.zshrc'))).toBe(cmdOf(root));
    } finally {
      chmodSync(lbin, 0o700); // restore so afterEach can remove it
    }
  });

  it('falls back to the dedicated dir when a preferred dir is on PATH but does not exist on disk', () => {
    const lbin = localBin(root); // on PATH (below) but never created
    const res = installCliShim(runtime({ shell: '/bin/zsh', currentPath: `${lbin}:/usr/bin` }));
    expect(asOk(res).path).toBe(cmdOf(root));
    expect(existsSync(join(lbin, CLI_COMMAND_NAME))).toBe(false);
    expect(resolvesFrom(join(root, '.zshrc'))).toBe(cmdOf(root));
  });

  it('falls back to the dedicated dir when a preferred path is on PATH but is a regular file', () => {
    mkdirSync(join(root, '.local'), { recursive: true });
    const lbin = localBin(root);
    writeFileSync(lbin, 'i am a file, not a directory\n');
    const res = installCliShim(runtime({ shell: '/bin/zsh', currentPath: `${lbin}:/usr/bin` }));
    expect(asOk(res).path).toBe(cmdOf(root));
  });

  it('falls back to the dedicated dir when the preferred dir is writable but the shim write fails', () => {
    const lbin = localBin(root);
    mkdirSync(join(lbin, CLI_COMMAND_NAME), { recursive: true }); // shim path occupied by a dir → write throws
    chmodSync(join(root, '.local'), 0o755); // pin dir + walked parent so reuse is SELECTED (and then the write fails) regardless of umask
    chmodSync(lbin, 0o755);
    const res = installCliShim(runtime({ shell: '/bin/zsh', currentPath: `${lbin}:/usr/bin` }));
    expect(asOk(res).path).toBe(cmdOf(root)); // recovered via the always-creatable dedicated dir
    expect(resolvesFrom(join(root, '.zshrc'))).toBe(cmdOf(root));
  });

  it.skipIf(isRoot)('falls back to the hardened dedicated dir when a parent of the preferred dir is group/other-writable (CWE-426)', () => {
    const lbin = localBin(root);
    mkdirSync(lbin, { recursive: true });
    chmodSync(lbin, 0o755); // ~/.local/bin itself is owner-only (pinned so the leaf passes the walk under any umask)
    chmodSync(join(root, '.local'), 0o777); // but its parent is world-writable → bin can be renamed and substituted
    const res = installCliShim(runtime({ shell: '/bin/zsh', currentPath: `${lbin}:/usr/bin` }));
    expect(asOk(res).path).toBe(cmdOf(root)); // not the dir under a tamperable ancestor
    expect(existsSync(join(lbin, CLI_COMMAND_NAME))).toBe(false);
    expect(resolvesFrom(join(root, '.zshrc'))).toBe(cmdOf(root));
  });

  it('installs into ~/bin when ~/.local/bin is absent but ~/bin is writable and on PATH', () => {
    const hbin = join(root, 'bin');
    mkdirSync(hbin, { recursive: true }); // ~/.local/bin never created → ~/bin is the preferred dir that qualifies
    chmodSync(hbin, 0o755); // pin perms so the fixture does not depend on the runner's umask
    const res = installCliShim(runtime({ shell: '/bin/zsh', currentPath: `${hbin}:/usr/bin` }));
    expect(asOk(res).path).toBe(join(hbin, CLI_COMMAND_NAME));
    expect(existsSync(join(root, '.zshrc'))).toBe(false); // already on PATH → no profile edit
    expect(existsSync(binOf(root))).toBe(false); // and no dedicated dir created
  });

  it.skipIf(isRoot)('falls back to the dedicated dir when the preferred dir is group-only-writable', () => {
    const lbin = localBin(root);
    mkdirSync(lbin, { recursive: true });
    chmodSync(lbin, 0o770); // group-writable but not other-writable: the macOS staff-group exposure
    try {
      expect(asOk(installCliShim(runtime({ shell: '/bin/zsh', currentPath: `${lbin}:/usr/bin` }))).path).toBe(cmdOf(root));
    } finally {
      chmodSync(lbin, 0o700);
    }
  });

  it.skipIf(isRoot)('falls back to the dedicated dir when an ancestor of the preferred dir is group-only-writable', () => {
    const lbin = localBin(root);
    mkdirSync(lbin, { recursive: true });
    chmodSync(lbin, 0o755);
    chmodSync(join(root, '.local'), 0o770); // group-writable ancestor: bin can be renamed by a group-mate
    expect(asOk(installCliShim(runtime({ shell: '/bin/zsh', currentPath: `${lbin}:/usr/bin` }))).path).toBe(cmdOf(root));
  });

  it.skipIf(isRoot)('falls back when the preferred dir is a symlink whose real ancestor is world-writable (CWE-59/426)', () => {
    const realParent = join(root, 'shared', 'tools');
    const realBin = join(realParent, 'binreal');
    mkdirSync(realBin, { recursive: true });
    chmodSync(realBin, 0o755);
    chmodSync(realParent, 0o777); // the symlink target's REAL parent is world-writable
    mkdirSync(join(root, '.local'), { recursive: true });
    symlinkSync(realBin, localBin(root)); // ~/.local/bin → .../shared/tools/binreal
    const res = installCliShim(runtime({ shell: '/bin/zsh', currentPath: `${localBin(root)}:/usr/bin` }));
    expect(asOk(res).path).toBe(cmdOf(root)); // lexical-only ancestor walk would miss the world-writable real parent
    expect(existsSync(join(realBin, CLI_COMMAND_NAME))).toBe(false);
  });

  it('resolves home through symlinks so the walk stops at the real home, not a world-writable grandparent', () => {
    // home is itself a symlink to a real dir whose REAL parent is world-writable. The ancestor walk must
    // stop at the resolved real home and not climb into that grandparent, so an owner-safe ~/.local/bin
    // under it is still accepted. A lexical (unresolved) home sentinel would overrun and wrongly decline.
    const grandparent = join(root, 'grandparent');
    const realHome = join(grandparent, 'realhome');
    mkdirSync(realHome, { recursive: true });
    chmodSync(grandparent, 0o777); // world-writable, but ABOVE the real home — must not be reached
    const home = join(root, 'home-link');
    symlinkSync(realHome, home); // home → .../grandparent/realhome
    const lbin = join(home, '.local', 'bin');
    mkdirSync(lbin, { recursive: true });
    chmodSync(join(home, '.local'), 0o755); // pin the walked parent too so the fixture does not depend on umask
    chmodSync(lbin, 0o755);
    const res = installCliShim(runtime({ home, shell: '/bin/zsh', currentPath: `${lbin}:/usr/bin` }));
    expect(asOk(res).path).toBe(join(lbin, CLI_COMMAND_NAME)); // accepted: walk terminates at the resolved real home
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

  it('preserves unrelated user lines that follow a prior block missing its end marker', () => {
    const profile = join(root, '.profile');
    writeFileSync(profile, '# >>> agent-terminal launcher >>>\nexport PATH="/stale/bin:$PATH"\nexport FOO=1\n');
    expect(installCliShim(runtime({ shell: '/bin/sh' })).ok).toBe(true);
    const after = readFileSync(profile, 'utf8');
    expect(after).toContain('export FOO=1');
    // Conservative recovery: with no end marker we cannot know the block's extent, so only the dangling
    // begin-marker line is removed — every other line (including the orphaned body) is left untouched.
    expect(after).toContain('export PATH="/stale/bin:$PATH"');
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

describe('installCliShim hardens the on-PATH bin directory permissions (CWE-276/732)', () => {
  it('creates the launcher directory and its app-owned parent owner-only, even under a permissive umask', () => {
    const prev = process.umask(0o000);
    try {
      expect(installCliShim(runtime({ shell: '/bin/sh' })).ok).toBe(true);
      // Owner-only (no group/other bits): closes the rename-and-substitute attack on an on-PATH dir,
      // and matches auditRecorder's 0o700 hardening of the shared ~/.agent-terminal root rather than re-widening it.
      expect(statSync(binOf(root)).mode & 0o077).toBe(0);
      expect(statSync(join(root, '.agent-terminal')).mode & 0o077).toBe(0);
    } finally {
      process.umask(prev);
    }
  });
});

describe('installCliShim does not let its bin directory shadow existing commands (CWE-426)', () => {
  it('appends the bin directory so a same-named file in it does not override a system command', () => {
    expect(installCliShim(runtime({ shell: '/bin/sh' })).ok).toBe(true);
    const bin = binOf(root);
    const decoy = join(bin, 'ls');
    writeFileSync(decoy, '#!/bin/sh\necho decoy\n');
    chmodSync(decoy, 0o755);
    const resolved = execFileSync('sh', ['-c', '. "$1"; command -v ls', 'sh', join(root, '.profile')], {
      env: { HOME: root, PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    }).trim();
    expect(resolved.startsWith(bin)).toBe(false); // system ls wins, not the planted decoy
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
