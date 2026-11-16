import { execFileSync } from 'node:child_process';
import { artifactCheckCommand, type ArtifactCheck } from '../../src/main/artifactCheck';

/** The argv a POSIX shell hands the checker script for the command the agent is given for `check` (everything
 *  after the script operand). */
export function checkerArgvOf(check: ArtifactCheck): string[] {
  const command = artifactCheckCommand({ execPath: '/bin/echo', script: 'SCRIPT' }, check);
  const printed = execFileSync('/bin/sh', ['-c', `${command.replace(/^ELECTRON_RUN_AS_NODE=1 /, '')} | tr ' ' '\\n'`], { encoding: 'utf8' });
  return printed.trim().split('\n').slice(1);
}
