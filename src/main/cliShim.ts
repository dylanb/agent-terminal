// agent-terminal launch shim generation (§23.4 / #25).

import path from 'node:path';
import { shellQuote } from '../shared/shellQuote';
import { APP_LAUNCH_DIR_ENV } from './launchRoot';

/** The launch invocation a generated shim execs to start a fresh, independent instance: the app
 *  binary plus the args needed to load this build (none when packaged, the main script in dev). */
export interface LaunchInvocation {
  execPath: string;
  appArgs: string[];
}

/** The installed command's filename. */
export const CLI_COMMAND_NAME = 'agent-terminal';

/** How to launch a fresh instance of this build: a packaged build execs its app binary with no extra
 *  args; a dev build (Electron loading a main script) execs Electron with that script, absolutized
 *  against `cwd` so the generated shim launches the same build from anywhere. */
export function resolveLaunchInvocation(
  execPath: string,
  isDevBuild: boolean,
  mainScript: string | undefined,
  cwd: string,
): LaunchInvocation {
  const appArgs = isDevBuild && mainScript ? [path.resolve(cwd, mainScript)] : [];
  return { execPath, appArgs };
}

/**
 * The POSIX shell launch shim (§23.4 / #25). An optional caller-supplied path crosses the OS boundary
 * as one verbatim directory operand, never shell-interpolated (CWE-78). A relative path resolves
 * against the invoking shell's cwd, not the launched process's; the instance starts detached so the
 * shell returns immediately.
 */
export function generateShim(invocation: LaunchInvocation): string {
  const cmd = [invocation.execPath, ...invocation.appArgs].map(shellQuote).join(' ');
  return [
    '#!/bin/sh',
    '# agent-terminal launcher (generated, §23.4) — reinstalling reconciles it to the current build.',
    'CWD=$(pwd)',
    'if [ "$#" -ge 1 ]; then',
    '  case "$1" in',
    `    /*) ${APP_LAUNCH_DIR_ENV}="$1" ;;`,
    `    *) ${APP_LAUNCH_DIR_ENV}="$CWD/$1" ;;`,
    '  esac',
    'else',
    `  ${APP_LAUNCH_DIR_ENV}="$CWD"`,
    'fi',
    `export ${APP_LAUNCH_DIR_ENV}`,
    `nohup ${cmd} >/dev/null 2>&1 &`,
    '',
  ].join('\n');
}
