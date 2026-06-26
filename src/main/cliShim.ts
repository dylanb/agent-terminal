// agent-terminal launch shim generation (§23.4 / #25).

import { APP_LAUNCH_DIR_ENV } from './launchRoot';

/** The launch invocation a generated shim execs to start a fresh, independent instance: the app
 *  binary plus the args needed to load this build (none when packaged, the main script in dev). */
export interface LaunchInvocation {
  execPath: string;
  appArgs: string[];
}

/** The installed command's filename. */
export const CLI_COMMAND_NAME = 'agent-terminal';

/** Wrap a string as one POSIX shell single-quoted literal so embedded metacharacters never evaluate. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The POSIX shell launch shim (§23.4 / #25). An optional caller-supplied path crosses the OS boundary
 * as one verbatim directory operand, never shell-interpolated (CWE-78). A relative path resolves
 * against the invoking shell's cwd, not the launched process's; the instance starts detached so the
 * shell returns immediately.
 */
export function generateShim(invocation: LaunchInvocation): string {
  const cmd = [invocation.execPath, ...invocation.appArgs].map(shQuote).join(' ');
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
