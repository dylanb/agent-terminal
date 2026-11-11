import fs from 'node:fs';
import path from 'node:path';
import { errMsg } from './errno';
import type { CliInstallResult } from '../shared/ipc';
import { shellQuote } from '../shared/shellQuote';
import { isValidCliInstall } from './ipcValidation';
import { generateShim, CLI_COMMAND_NAME, type LaunchInvocation } from './cliShim';
import { ownerOnlyChain, ownerOnlyPath } from './ownerOnlyPath';

interface InstallTarget {
  binDir: string;
  ownsBinDir: boolean;
  profiles: string[];
  reconcileProfiles?: string[];
  currentPath: string;
  invocation: LaunchInvocation;
  checkerScript: string;
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

const PROFILE_CANDIDATES = [
  ...new Set(Object.values(SHELL_PROFILES).flatMap((s) => [...s.sources, ...s.create])),
];

export interface RuntimeInfo {
  home: string;
  shell: string;
  currentPath: string;
  invocation: LaunchInvocation;
  uid: number;
  /** The checker runtime script of this build, which the installed `--validate-flow` runs. */
  checkerScript: string;
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
    checkerScript: info.checkerScript,
  };
}

const PREFERRED_BIN_DIRS = [path.join('.local', 'bin'), 'bin'];

function isSafeReuseDir(dir: string, home: string, uid: number): boolean {
  let realHome: string;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
    fs.accessSync(dir, fs.constants.W_OK);
    realHome = fs.realpathSync(home);
  } catch {
    return false;
  }
  const check = ownerOnlyChain(dir, uid, realHome);
  switch (check.kind) {
    case 'ownerOnly':
      return true;
    case 'othersCanWrite':
    case 'ownedByAnother':
      return false;
    // untestable: the dir was just stat-ed, so its chain is unreadable only if it changes in between; tracked in #153.
    case 'unreadable':
      return false;
    default:
      return check satisfies never;
  }
}

function appImageRefusal(appImage: string, uid: number): string | undefined {
  const folder = path.dirname(appImage);
  const unsafe = (what: string, reason: string, fix: string): string =>
    `Not installing the command: ${what} ${reason}, who could swap the app. ${fix}, then install again.`;
  const unreadable = (what: string, e: unknown): string =>
    `Not installing the command: could not check who can write ${what}: ${errMsg(e)}`;
  let realFile: string;
  try {
    realFile = fs.realpathSync(appImage);
  } catch (e) {
    return unreadable(appImage, e);
  }
  const named = realFile === appImage ? appImage : `${appImage} (${realFile})`;
  const moveIt = 'Keep the AppImage somewhere only you can write';
  const checks = [
    { checked: folder, what: `${folder} (or a folder above it)`, run: () => ownerOnlyChain(folder, uid), writableFix: moveIt },
    {
      checked: path.dirname(realFile),
      what: `${appImage}, or a folder above ${realFile},`,
      run: () => ownerOnlyChain(path.dirname(realFile), uid),
      writableFix: moveIt,
    },
    { checked: named, what: named, run: () => ownerOnlyPath(realFile, uid), writableFix: `Run chmod go-w ${shellQuote(realFile)}` },
  ];
  for (const { checked, what, run, writableFix } of checks) {
    const check = run();
    switch (check.kind) {
      case 'ownerOnly':
        continue;
      case 'othersCanWrite':
        return unsafe(what, 'can be written by other users', writableFix);
      case 'ownedByAnother':
        return unsafe(what, 'is owned by another user', 'Copy the AppImage somewhere only you can write');
      // untestable: the AppImage path just resolved, so these are unreadable only if they change in between; tracked in #153.
      case 'unreadable':
        return unreadable(checked, check.error);
      default:
        return check satisfies never;
    }
  }
  return undefined;
}

function launchTargetRefusal(invocation: LaunchInvocation, uid: number): string | undefined {
  switch (invocation.kind) {
    case 'binary':
      return undefined;
    case 'appImage':
      return appImageRefusal(invocation.appImage, uid);
    default:
      return invocation satisfies never;
  }
}

function preferredOnPathBinDir(home: string, currentPath: string, uid: number): string | undefined {
  for (const rel of PREFERRED_BIN_DIRS) {
    const dir = path.join(home, rel);
    if (onPath(dir, currentPath) && isSafeReuseDir(dir, home, uid)) return dir;
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

export function handleCliInstall(m: unknown, gatherRuntime: () => RuntimeInfo): CliInstallResult {
  if (!isValidCliInstall(m)) return { ok: false, error: 'invalid install request' };
  return installCliShim(gatherRuntime());
}

export function installCliShim(runtime: RuntimeInfo): CliInstallResult {
  const refusal = launchTargetRefusal(runtime.invocation, runtime.uid);
  if (refusal) return { ok: false, error: refusal };
  const existingProfiles = PROFILE_CANDIDATES.map((n) => path.join(runtime.home, n)).filter((p) =>
    fs.existsSync(p),
  );
  const preferred = preferredOnPathBinDir(runtime.home, runtime.currentPath, runtime.uid);
  if (preferred) {
    const result = performInstall({
      binDir: preferred,
      ownsBinDir: false,
      profiles: [],
      reconcileProfiles: existingProfiles,
      currentPath: runtime.currentPath,
      invocation: runtime.invocation,
      checkerScript: runtime.checkerScript,
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
      // CWE-276/426. The parent is ~/.agent-terminal, which also holds the audit logs at 0o700; anything wider re-opens them.
      fs.chmodSync(path.dirname(target.binDir), 0o700);
      fs.chmodSync(target.binDir, 0o700);
    }
    fs.writeFileSync(cmd, generateShim(target.invocation, target.checkerScript));
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
