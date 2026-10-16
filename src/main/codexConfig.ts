// §18.1 v2.199.

import os from 'node:os';
import path from 'node:path';

/** `null` when the result is relative: Codex resolves a relative CODEX_HOME against its own cwd, so the value
 *  names no single directory, and anchoring it at ours would seed one Codex never reads (CWE-829). */
export function codexHomeFrom(env: NodeJS.ProcessEnv, home: string): string | null {
  const override = env.CODEX_HOME?.trim();
  const root = override ? override : path.join(home, '.codex');
  return path.isAbsolute(root) ? root : null;
}

export function codexHome(): string | null {
  return codexHomeFrom(process.env, os.homedir());
}

export function codexLoopsV2Dir(codexHomeDir: string): string {
  return path.join(codexHomeDir, 'loops-v2');
}

export function codexAgentsDir(codexHomeDir: string): string {
  return path.join(codexHomeDir, 'agents');
}

export function codexSkillsDir(codexHomeDir: string): string {
  return path.join(codexHomeDir, 'skills');
}
