// Claude Code's user-level config directories (§24.2.3, §26.10). One definition of the root, consumed by
// the loop-name resolver's no-override branch, by the install action's targets, and by the cost meter's
// session logs — so a CLAUDE_CONFIG_DIR redirect can never move one of them without the others.

import os from 'node:os';
import path from 'node:path';

/** A blank override is UNSET, not the empty path: `??` would let an exported-but-empty CLAUDE_CONFIG_DIR
 *  through, and every destination below it would then be a bare relative name that a writer anchors at the
 *  process cwd — seeding the user's checked-out repo. `launchRoot.homeFallback` reads `$HOME` the same way. */
const set = (v: string | undefined): string | undefined => (v?.trim() ? v : undefined);

/** The root, resolved against a supplied environment and home dir — for callers that take both injected. */
export function userConfigRootFrom(env: NodeJS.ProcessEnv, home: string, configDir?: string): string {
  return set(configDir) ?? set(env.CLAUDE_CONFIG_DIR) ?? path.join(home, '.claude');
}

export function userConfigRoot(configDir?: string): string {
  return userConfigRootFrom(process.env, os.homedir(), configDir);
}

/** The engine's loop-config location (`agent-loop list`). NOT precedence-aware: this is the named
 *  user-config branch a writer targets, never the repo-local override a reader may prefer (§24.2.3). */
export function userConfigLoopsDir(configDir?: string): string {
  return path.join(userConfigRoot(configDir), 'loops');
}

/** Where Claude Code — a separate process — discovers a skill, as `<root>/skills/<skill name>/`. */
export function userConfigSkillsDir(configDir?: string): string {
  return path.join(userConfigRoot(configDir), 'skills');
}

/** Where Claude Code — a separate process — discovers a slash command, as `<root>/commands/<name>.md`. */
export function userConfigCommandsDir(configDir?: string): string {
  return path.join(userConfigRoot(configDir), 'commands');
}
