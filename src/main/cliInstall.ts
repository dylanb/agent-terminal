// agent-terminal CLI shim installer (§23.4 / #25): writes the launch shim and ensures it is on PATH
// for new shells, idempotently reconciling to the running build.

import fs from 'node:fs';
import path from 'node:path';
import { errMsg } from './errno';
import type { CliInstallResult } from '../shared/ipc';
import { shellQuote } from '../shared/shellQuote';
import { isValidCliInstall } from './ipcValidation';
import { generateShim, CLI_COMMAND_NAME, type LaunchInvocation } from './cliShim';

/** The resolved filesystem work of one install. Internal to this module — the public seam is
 *  RuntimeInfo. `reconcileProfiles` are profiles to strip orphan launcher blocks from (e.g. left by a
 *  former shell), distinct from `profiles`, the ones the active shell sources and gets the new block.
 *  `ownsBinDir` is true only for the app-created `~/.agent-terminal/bin`; false for a reused user dir,
 *  which the installer must neither create nor re-permission. */
interface InstallTarget {
  binDir: string;
  ownsBinDir: boolean;
  profiles: string[];
  reconcileProfiles?: string[];
  currentPath: string;
  invocation: LaunchInvocation;
}

interface ShellProfileSpec {
  sources: string[];
  create: string[];
}

const SHELL_PROFILES: Record<string, ShellProfileSpec> = {
  zsh: { sources: ['.zshrc', '.zprofile'], create: ['.zshrc'] },
  bash: { sources: ['.bashrc', '.bash_profile', '.profile'], create: ['.bashrc', '.profile'] },
  sh: { sources: ['.profile'], create: ['.profile'] },
  dash: { sources: ['.profile'], create: ['.profile'] },
};

/** Dotfiles any supported shell might source — derived from SHELL_PROFILES so the two cannot drift.
 *  The installer keeps the existing ones to pick those the active shell reads and to reconcile orphan
 *  blocks left in profiles a former shell sourced. */
const PROFILE_CANDIDATES = [
  ...new Set(Object.values(SHELL_PROFILES).flatMap((s) => [...s.sources, ...s.create])),
];

/** The running build's launch facts the installer needs (§23.4 / #25) — its single public input.
 *  Names domain concepts, not the process/fs shapes that supply them: the user's home, their shell
 *  (which dotfiles to extend PATH in), the current PATH, and a resolved launch invocation. */
export interface RuntimeInfo {
  home: string;
  shell: string;
  currentPath: string;
  invocation: LaunchInvocation;
}

function resolveProfiles(home: string, shell: string, existing: string[]): string[] {
  const spec = SHELL_PROFILES[path.basename(shell || '')];
  if (!spec) return [];
  const have = new Set(existing);
  const present = spec.sources.map((n) => path.join(home, n)).filter((p) => have.has(p));
  return present.length ? present : spec.create.map((n) => path.join(home, n));
}

function buildInstallTarget(info: RuntimeInfo, existingProfiles: string[]): InstallTarget {
  return {
    binDir: path.join(info.home, '.agent-terminal', 'bin'),
    ownsBinDir: true,
    profiles: resolveProfiles(info.home, info.shell, existingProfiles),
    reconcileProfiles: existingProfiles,
    currentPath: info.currentPath,
    invocation: info.invocation,
  };
}

/** User bin directories the installer prefers when one is ALREADY on PATH — landing the command where
 *  the user's shells already look means no profile edit and no new shell (the original failure: a
 *  launcher installed into a dir nobody's PATH includes). */
const PREFERRED_BIN_DIRS = [path.join('.local', 'bin'), 'bin'];

/** Whether a pre-existing on-PATH user dir is safe to host the launcher. A reused dir is never
 *  re-permissioned, so it must be vetted and, failing that, declined for the dedicated dir — otherwise
 *  another local user could rename the dir (or an ancestor) and substitute a hostile launcher
 *  (CWE-276/426), the same attack the dedicated-dir path blocks by hardening its own parent to 0o700.
 *  Symlinks are resolved first (CWE-59): a symlinked dir's real ancestors are what an attacker
 *  manipulates, not the lexical path. */
function isSafeReuseDir(dir: string, home: string): boolean {
  let real: string;
  let realHome: string;
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory() || (st.mode & 0o022) !== 0) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    real = fs.realpathSync(dir);
    realHome = fs.realpathSync(home);
  } catch {
    return false;
  }
  return ancestorsOwnerOnly(path.dirname(real), realHome);
}

type OwnerOnlyWalk = { ok: true } | { ok: false; error: unknown };

/** Whether `start` and every ancestor above it, up to but excluding `stopAt` (default: through `/`),
 *  is free of group/other write. `start` must already be symlink-resolved; a stat failure is
 *  reported with its cause. */
function walkOwnerOnly(start: string, stopAt?: string): OwnerOnlyWalk {
  for (let cur = start; cur !== stopAt; cur = path.dirname(cur)) {
    try {
      if ((fs.statSync(cur).mode & 0o022) !== 0) return { ok: false, error: undefined };
    } catch (e) {
      return { ok: false, error: e };
    }
    if (cur === path.dirname(cur)) break;
  }
  return { ok: true };
}

function ancestorsOwnerOnly(start: string, stopAt?: string): boolean {
  return walkOwnerOnly(start, stopAt).ok;
}

function appImageFolderRefusal(appImage: string): string | undefined {
  const folder = path.dirname(appImage);
  const writable = (what: string): string =>
    `Not installing the command: ${what} can be written by other users, who could swap the app. Keep the AppImage somewhere only you can write, then install again.`;
  try {
    fs.realpathSync(folder);
    const realFile = fs.realpathSync(appImage);
    if ((fs.statSync(realFile).mode & 0o022) !== 0) return writable(appImage);
    const walk = walkOwnerOnly(path.dirname(realFile));
    if (walk.ok) return undefined;
    if (walk.error === undefined) {
      return writable(
        path.dirname(realFile) === folder ? `${folder} (or a folder above it)` : `${appImage}, or a folder above ${realFile},`,
      );
    }
    throw walk.error;
  } catch (e) {
    return `Not installing the command: could not check who can write ${folder}: ${errMsg(e)}`;
  }
}

function preferredOnPathBinDir(home: string, currentPath: string): string | undefined {
  for (const rel of PREFERRED_BIN_DIRS) {
    const dir = path.join(home, rel);
    if (onPath(dir, currentPath) && isSafeReuseDir(dir, home)) return dir;
  }
  return undefined;
}

const PATH_BLOCK_BEGIN = '# >>> agent-terminal launcher >>>';
const PATH_BLOCK_END = '# <<< agent-terminal launcher <<<';

function pathBlock(binDir: string): string {
  const q = shellQuote(binDir);
  return [
    PATH_BLOCK_BEGIN,
    `case ":$PATH:" in`,
    `  *:${q}:*) ;;`,
    `  *) export PATH="$PATH":${q} ;;`,
    'esac',
    PATH_BLOCK_END,
    '',
  ].join('\n');
}

function stripBlock(text: string): string {
  const begin = text.indexOf(PATH_BLOCK_BEGIN);
  if (begin === -1) return text;
  const end = text.indexOf(PATH_BLOCK_END, begin);
  if (end === -1) {
    const lineEnd = text.indexOf('\n', begin);
    const tail = lineEnd === -1 ? text.length : lineEnd + 1;
    return text.slice(0, begin) + text.slice(tail);
  }
  const after = end + PATH_BLOCK_END.length;
  const tail = text[after] === '\n' ? after + 1 : after;
  return text.slice(0, begin) + text.slice(tail);
}

function onPath(binDir: string, currentPath: string): boolean {
  return currentPath.split(path.delimiter).includes(binDir);
}


function reconcileOrphanBlocks(target: InstallTarget): void {
  const writeTargets = new Set(target.profiles);
  for (const profile of target.reconcileProfiles ?? []) {
    if (writeTargets.has(profile)) continue;
    try {
      const existing = fs.readFileSync(profile, 'utf8');
      const next = stripBlock(existing);
      if (next !== existing) fs.writeFileSync(profile, next);
    } catch {
      continue;
    }
  }
}

/** The cli:install handler (§6 / §23.4): reject anything that is not a valid live-session request
 *  before any environment or filesystem work, else install onto PATH. `gatherRuntime` is consulted
 *  only on the accepted path, so a rejected request produces no install side effects. */
export function handleCliInstall(m: unknown, gatherRuntime: () => RuntimeInfo): CliInstallResult {
  if (!isValidCliInstall(m)) return { ok: false, error: 'invalid install request' };
  return installCliShim(gatherRuntime());
}

/** Install the launcher for `runtime` onto PATH, idempotently reconciling to the current build, and
 *  report whether it is now runnable from a new shell (§23.4 / #25). */
export function installCliShim(runtime: RuntimeInfo): CliInstallResult {
  if ('appImage' in runtime.invocation) {
    const refusal = appImageFolderRefusal(runtime.invocation.appImage);
    if (refusal) return { ok: false, error: refusal };
  }
  const existingProfiles = PROFILE_CANDIDATES.map((n) => path.join(runtime.home, n)).filter((p) =>
    fs.existsSync(p),
  );
  const preferred = preferredOnPathBinDir(runtime.home, runtime.currentPath);
  if (preferred) {
    const result = performInstall({
      binDir: preferred,
      ownsBinDir: false,
      profiles: [],
      reconcileProfiles: existingProfiles,
      currentPath: runtime.currentPath,
      invocation: runtime.invocation,
    });
    if (result.ok) return result;
  }
  return performInstall(buildInstallTarget(runtime, existingProfiles));
}

function performInstall(target: InstallTarget): CliInstallResult {
  const cmd = path.join(target.binDir, CLI_COMMAND_NAME);
  try {
    if (target.ownsBinDir) {
      fs.mkdirSync(target.binDir, { recursive: true });
      // Owner-only on the on-PATH executable dir AND its app-owned parent: a world-traversable/writable
      // ancestor lets another user rename bin and substitute a hostile launcher (CWE-276/426). 0o700 also
      // matches auditRecorder's hardening of the shared ~/.agent-terminal root rather than re-widening it.
      fs.chmodSync(path.dirname(target.binDir), 0o700);
      fs.chmodSync(target.binDir, 0o700);
    }
    fs.writeFileSync(cmd, generateShim(target.invocation));
    fs.chmodSync(cmd, 0o755);
  } catch (e) {
    return { ok: false, error: `Could not write the launcher to ${target.binDir}: ${errMsg(e)}` };
  }

  reconcileOrphanBlocks(target);

  if (onPath(target.binDir, target.currentPath)) return { ok: true, path: cmd };

  if (target.profiles.length === 0) {
    return {
      ok: false,
      error: `Could not add the launcher to PATH automatically (unsupported shell). Add this directory to your PATH: ${target.binDir}`,
    };
  }

  const block = pathBlock(target.binDir);
  let extended = false;
  for (const profile of target.profiles) {
    try {
      const existing = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : '';
      const next = stripBlock(existing);
      const sep = next.length === 0 || next.endsWith('\n') ? '' : '\n';
      fs.writeFileSync(profile, next + sep + block);
      extended = true;
    } catch {
      continue;
    }
  }
  if (!extended) {
    return { ok: false, error: 'Could not add the launcher to PATH: no writable shell profile.' };
  }
  return { ok: true, path: cmd };
}
