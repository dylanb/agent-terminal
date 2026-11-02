// Claude Code's user-level config directories (§24.2.3). One definition of the root, consumed by
// the loop-name resolver's no-override branch and by the install action's targets — so a
// CLAUDE_CONFIG_DIR redirect can never move one of them without the others.

import os from 'node:os';
import path from 'node:path';

export const LOOPS_V2_SUBDIR = 'loops-v2';
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
export const CLAUDE_CONFIG_DEFAULT_SUBDIR = '.claude';

const trimmed = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/** The root, resolved against a supplied environment and home dir — for callers that take both injected.
 *  `null` when an override is set to something no cwd could make right: a RELATIVE path. Claude Code is a
 *  separate process with its own cwd and resolves the same variable against that, so a relative value has no
 *  single meaning; anchoring it at ours seeds a directory Claude Code never reads, and a relative
 *  CLAUDE_CONFIG_DIR would anchor the config root at the process cwd, which a cloned repo can influence
 *  (CWE-829). Callers surface the refusal; none guess. */
export function userConfigRootFrom(
  env: NodeJS.ProcessEnv,
  home: string,
  configDir?: string,
): string | null {
  const override = trimmed(configDir) ?? trimmed(env.CLAUDE_CONFIG_DIR);
  const root = override ?? path.join(home, '.claude');
  // The absoluteness gate is on the RESULT, not just the override branch: a defined-but-empty `$HOME` makes
  // `os.homedir()` return '', so the unset branch is `.claude` — relative, and the same CWE-829 sink. Only an
  // absolute root can be right; anything else is refused whichever branch produced it.
  return path.isAbsolute(root) ? root : null;
}

export function userConfigRoot(configDir?: string): string | null {
  return userConfigRootFrom(process.env, os.homedir(), configDir);
}

const branch = (sub: string, configDir?: string): string | null => {
  const root = userConfigRoot(configDir);
  return root === null ? null : path.join(root, sub);
};

/** The engine's loop-config location (`agent-loop list`). NOT precedence-aware: this is the named
 *  user-config branch a writer targets, never the repo-local override a reader may prefer (§24.2.3). */
export function userConfigLoopsDir(configDir?: string): string | null {
  return branch('loops', configDir);
}

/** The operator tier for §27 (v2) loop defs, `<root>/loops-v2/<name>/<name>.yaml` — a sibling of the
 *  `loops` dir, never nested in it, so the two schemas' operator trees stay disjoint (§27.15). `null` when
 *  the root is refused (the same relative-override / CWE-829 gate as every other branch). */
export function userConfigLoopsV2Dir(configDir?: string): string | null {
  return branch('loops-v2', configDir);
}

/** Where Claude Code — a separate process — discovers a slash command, as `<root>/commands/<name>.md`. */
export function userConfigCommandsDir(configDir?: string): string | null {
  return branch('commands', configDir);
}

/** Where Claude Code discovers a sub-agent, as `<root>/agents/<name>.md`, when a session starts. */
export function userConfigAgentsDir(configDir?: string): string | null {
  return branch('agents', configDir);
}
