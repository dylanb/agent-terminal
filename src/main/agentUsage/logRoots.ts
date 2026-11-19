// The log sweep and the tests' fixture writers both resolve agent log folders here, so a fixture lands exactly
// where the sweep looks.

import { realpathSync } from 'node:fs';
import path from 'node:path';

declare const agentWorkingDirBrand: unique symbol;
/** A directory as an agent records it for a session it ran in: a real path, which only `agentWorkingDir` makes. */
export type AgentWorkingDir = string & { readonly [agentWorkingDirBrand]: true };

export function agentWorkingDir(worktree: string): AgentWorkingDir {
  return realpathSync(worktree) as AgentWorkingDir;
}

/** Claude Code shortens the folder name of a very long path, which this does not reproduce. */
export function claudeCodeProjectLogDir(configRoot: string, workingDir: AgentWorkingDir): string {
  return path.join(configRoot, 'projects', workingDir.replace(/[^A-Za-z0-9]/g, '-'));
}

/** Codex's one log folder, shared by every worktree; each rollout file records its own working directory. */
export function codexSessionsDir(codexHome: string): string {
  return path.join(codexHome, 'sessions');
}
