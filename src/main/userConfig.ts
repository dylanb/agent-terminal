// Claude Code's user-level config directories (§24.2.3). One definition of the root, consumed by the
// loop-name resolver's no-override branch and by the install action's targets, so a global install can
// never seed a directory the engine does not read.

import os from 'node:os';
import path from 'node:path';

export function userConfigRoot(configDir?: string): string {
  return configDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
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
