// Claude Code's user-level config directories (§24.2.3, §26.10). One definition of the root, consumed by
// the loop-name resolver's no-override branch, by the install action's targets, and by the cost meter's
// session logs — so a CLAUDE_CONFIG_DIR redirect can never move one of them without the others.

import os from 'node:os';
import path from 'node:path';

const trimmed = (v: string | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

/** The root, resolved against a supplied environment and home dir — for callers that take both injected.
 *  `null` when an override is set to something no cwd could make right: a RELATIVE path. Claude Code is a
 *  separate process with its own cwd and resolves the same variable against that, so a relative value has no
 *  single meaning; anchoring it at ours seeds a directory Claude Code never reads, and — when the app was
 *  launched from a repo — lands it in the working tree, where `loopDef` would stamp it `operator-config`,
 *  the origin §26.6 grants `exec` authority on (CWE-829). Callers surface the refusal; none guess. */
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

/** Where Claude Code — a separate process — discovers a skill, as `<root>/skills/<skill name>/`. */
export function userConfigSkillsDir(configDir?: string): string | null {
  return branch('skills', configDir);
}

/** Where Claude Code — a separate process — discovers a slash command, as `<root>/commands/<name>.md`. */
export function userConfigCommandsDir(configDir?: string): string | null {
  return branch('commands', configDir);
}
