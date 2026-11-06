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

export const CONTROLLER_FLAG = '--controller';
export const VALIDATE_FLOW_FLAG = '--validate-flow';
export const CONTROLLER_PRODUCT_NAME = 'agent-terminal-controller';
export const CONTROLLER_OUTPUT_SUBDIR = 'controller';

const DEV_CONTROLLER_ENTRY = 'controller.js';
const MAC_BUNDLE_BINARY = /^(.*)\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/;

/** Where the controller of the same build as `invocation` may be: installed beside the terminal
 *  (/Applications, /opt), then in the controller package's build output beside the terminal's. */
export function controllerInvocations(invocation: LaunchInvocation): LaunchInvocation[] {
  const [mainScript] = invocation.appArgs;
  if (mainScript) {
    return [{ execPath: invocation.execPath, appArgs: [path.join(path.dirname(mainScript), DEV_CONTROLLER_ENTRY)] }];
  }
  const mac = MAC_BUNDLE_BINARY.exec(invocation.execPath);
  const hostDir = mac ? mac[1] : path.dirname(invocation.execPath);
  const binaryIn = (dir: string): string =>
    mac
      ? path.join(dir, `${CONTROLLER_PRODUCT_NAME}.app`, 'Contents', 'MacOS', CONTROLLER_PRODUCT_NAME)
      : path.join(dir, CONTROLLER_PRODUCT_NAME);
  const installed = mac ? hostDir : path.join(path.dirname(hostDir), CONTROLLER_PRODUCT_NAME);
  const built = path.join(path.dirname(hostDir), CONTROLLER_OUTPUT_SUBDIR, path.basename(hostDir));
  return [installed, built].map((dir) => ({ execPath: binaryIn(dir), appArgs: [] }));
}

function controllerBranch(invocation: LaunchInvocation): string[] {
  const candidates = controllerInvocations(invocation);
  const launches = candidates.map(({ execPath, appArgs }) => {
    const present = [`[ -x ${shellQuote(execPath)} ]`, ...appArgs.map((a) => `[ -f ${shellQuote(a)} ]`)];
    const cmd = [execPath, ...appArgs].map(shellQuote).join(' ');
    return `  if ${present.join(' && ')}; then nohup ${cmd} >/dev/null 2>&1 & exit 0; fi`;
  });
  const looked = candidates.map((c) => c.appArgs[0] ?? c.execPath).join(', ');
  return [
    `if [ "$#" -ge 1 ] && [ "$1" = ${CONTROLLER_FLAG} ]; then`,
    ...launches,
    `  printf '%s\\n' ${shellQuote(`${CLI_COMMAND_NAME}: no controller app found (looked for ${looked})`)} >&2`,
    '  exit 1',
    'fi',
  ];
}

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

// A dev build's main script is deliberately left out: in plain-Node mode the checker script is the program.
function validateFlowBranch(invocation: LaunchInvocation, checkerScript: string): string[] {
  return [
    `if [ "$#" -ge 1 ] && [ "$1" = ${shellQuote(VALIDATE_FLOW_FLAG)} ]; then`,
    '  ELECTRON_RUN_AS_NODE=1',
    '  export ELECTRON_RUN_AS_NODE',
    `  exec ${shellQuote(invocation.execPath)} ${shellQuote(checkerScript)} "$@"`,
    'fi',
  ];
}

/**
 * The POSIX shell launch shim (§23.4 / #25). An optional caller-supplied path crosses the OS boundary
 * as one verbatim directory operand, never shell-interpolated (CWE-78). A relative path resolves
 * against the invoking shell's cwd, not the launched process's; the instance starts detached so the
 * shell returns immediately. `--validate-flow` instead runs `checkerScript` in the foreground.
 */
export function generateShim(invocation: LaunchInvocation, checkerScript: string): string {
  const cmd = [invocation.execPath, ...invocation.appArgs].map(shellQuote).join(' ');
  return [
    '#!/bin/sh',
    '# agent-terminal launcher (generated, §23.4) — reinstalling reconciles it to the current build.',
    ...validateFlowBranch(invocation, checkerScript),
    ...controllerBranch(invocation),
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
