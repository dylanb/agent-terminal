// agent-terminal CLI shim installer (§23.4 / #25): writes the launch shim and ensures it is on PATH
// for new shells, idempotently reconciling to the running build.

import fs from 'node:fs';
import path from 'node:path';
import type { CliInstallResult } from '../shared/ipc';
import { generateShim, shQuote, CLI_COMMAND_NAME, type LaunchInvocation } from './cliShim';

/** Where the install lands, injected as a domain seam so tests install into a temp PATH/profile
 *  (CLAUDE.md "narrow domain seam"): the shim's bin directory, the shell-profile files to extend
 *  PATH in, and the current PATH used to decide whether the bin directory is already reachable. */
export interface InstallTarget {
  binDir: string;
  profiles: string[];
  currentPath: string;
  invocation: LaunchInvocation;
}

/** Dotfiles any supported shell might source; the handler filters this to the ones that exist so the
 *  pure target builder can pick those the active shell actually reads. */
export const PROFILE_CANDIDATES = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile', '.kshrc'];

interface ShellProfileSpec {
  sources: string[];
  create: string[];
}

const SHELL_PROFILES: Record<string, ShellProfileSpec> = {
  zsh: { sources: ['.zshrc', '.zprofile'], create: ['.zshrc'] },
  bash: { sources: ['.bashrc', '.bash_profile', '.profile'], create: ['.bashrc', '.profile'] },
  sh: { sources: ['.profile'], create: ['.profile'] },
  dash: { sources: ['.profile'], create: ['.profile'] },
  ash: { sources: ['.profile'], create: ['.profile'] },
  ksh: { sources: ['.kshrc', '.profile'], create: ['.profile'] },
};

/** The running build's launch facts, from which the install target is derived. */
export interface RuntimeInfo {
  home: string;
  shell: string;
  currentPath: string;
  execPath: string;
  defaultApp: boolean;
  mainScript?: string;
  cwd: string;
  existingProfiles: string[];
}

function resolveProfiles(home: string, shell: string, existing: string[]): string[] {
  const spec = SHELL_PROFILES[path.basename(shell || '')];
  if (!spec) return [];
  const have = new Set(existing);
  const present = spec.sources.map((n) => path.join(home, n)).filter((p) => have.has(p));
  return present.length ? present : spec.create.map((n) => path.join(home, n));
}

export function buildInstallTarget(info: RuntimeInfo): InstallTarget {
  const binDir = path.join(info.home, '.agent-terminal', 'bin');
  const profiles = resolveProfiles(info.home, info.shell, info.existingProfiles);
  const appArgs = info.defaultApp && info.mainScript ? [path.resolve(info.cwd, info.mainScript)] : [];
  return { binDir, profiles, currentPath: info.currentPath, invocation: { execPath: info.execPath, appArgs } };
}

const PATH_BLOCK_BEGIN = '# >>> agent-terminal launcher >>>';
const PATH_BLOCK_END = '# <<< agent-terminal launcher <<<';

function pathBlock(binDir: string): string {
  const q = shQuote(binDir);
  return [
    PATH_BLOCK_BEGIN,
    `case ":$PATH:" in`,
    `  *:${q}:*) ;;`,
    `  *) export PATH=${q}:"$PATH" ;;`,
    'esac',
    PATH_BLOCK_END,
    '',
  ].join('\n');
}

function stripBlock(text: string): string {
  const begin = text.indexOf(PATH_BLOCK_BEGIN);
  if (begin === -1) return text;
  const end = text.indexOf(PATH_BLOCK_END, begin);
  if (end === -1) return text.slice(0, begin);
  const after = end + PATH_BLOCK_END.length;
  const tail = text[after] === '\n' ? after + 1 : after;
  return text.slice(0, begin) + text.slice(tail);
}

function onPath(binDir: string, currentPath: string): boolean {
  return currentPath.split(path.delimiter).includes(binDir);
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function installCliShim(target: InstallTarget): CliInstallResult {
  const cmd = path.join(target.binDir, CLI_COMMAND_NAME);
  try {
    fs.mkdirSync(target.binDir, { recursive: true });
    fs.writeFileSync(cmd, generateShim(target.invocation));
    fs.chmodSync(cmd, 0o755);
  } catch (e) {
    return { ok: false, error: `Could not write the launcher to ${target.binDir}: ${errMsg(e)}` };
  }

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
