// agent-terminal launch shim generation (§23.4 / #25).

import path from 'node:path';
import { shellQuote } from '../shared/shellQuote';
import { APP_LAUNCH_DIR_ENV } from './launchRoot';

/** The launch invocation a generated shim execs to start a fresh, independent instance of this build. */
export type LaunchInvocation =
  | { kind: 'packaged'; execPath: string }
  | {
      kind: 'development';
      execPath: string;
      /** The absolute path Electron was started on. Under electron-vite dev it is the app root, not the
       *  main bundle, so the controller entry is never derived from it. */
      startPath: string;
      /** The directory the running main bundle loads from. */
      mainDir: string;
    };

interface ShimCommand {
  execPath: string;
  args: string[];
}

/** The installed command's filename. */
export const CLI_COMMAND_NAME = 'agent-terminal';

export const CONTROLLER_FLAG = '--controller';
export const CONTROLLER_PRODUCT_NAME = 'agent-terminal-controller';
export const CONTROLLER_OUTPUT_SUBDIR = 'controller';

const DEV_CONTROLLER_ENTRY = 'controller.js';
const MAC_BUNDLE_BINARY = /^(.*)\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/;

/** Where the controller of the same build as `invocation` may be: installed beside the terminal
 *  (/Applications, /opt), then in the controller package's build output beside the terminal's. */
export function controllerInvocations(invocation: LaunchInvocation): ShimCommand[] {
  if (invocation.kind === 'development') {
    return [{ execPath: invocation.execPath, args: [path.join(invocation.mainDir, DEV_CONTROLLER_ENTRY)] }];
  }
  const mac = MAC_BUNDLE_BINARY.exec(invocation.execPath);
  const hostDir = mac ? mac[1] : path.dirname(invocation.execPath);
  const binaryIn = (dir: string): string =>
    mac
      ? path.join(dir, `${CONTROLLER_PRODUCT_NAME}.app`, 'Contents', 'MacOS', CONTROLLER_PRODUCT_NAME)
      : path.join(dir, CONTROLLER_PRODUCT_NAME);
  const installed = mac ? hostDir : path.join(path.dirname(hostDir), CONTROLLER_PRODUCT_NAME);
  const built = path.join(path.dirname(hostDir), CONTROLLER_OUTPUT_SUBDIR, path.basename(hostDir));
  return [installed, built].map((dir) => ({ execPath: binaryIn(dir), args: [] }));
}

function controllerBranch(invocation: LaunchInvocation): string[] {
  const candidates = controllerInvocations(invocation);
  const launches = candidates.map(({ execPath, args }) => {
    const present = [`[ -x ${shellQuote(execPath)} ]`, ...args.map((a) => `[ -f ${shellQuote(a)} ]`)];
    const cmd = [execPath, ...args].map(shellQuote).join(' ');
    return `  if ${present.join(' && ')}; then nohup ${cmd} >/dev/null 2>&1 & exit 0; fi`;
  });
  const looked = candidates.map((c) => c.args[0] ?? c.execPath).join(', ');
  return [
    `if [ "$#" -ge 1 ] && [ "$1" = ${CONTROLLER_FLAG} ]; then`,
    ...launches,
    `  printf '%s\\n' ${shellQuote(`${CLI_COMMAND_NAME}: no controller app found (looked for ${looked})`)} >&2`,
    '  exit 1',
    'fi',
  ];
}

/** How to launch a fresh instance of this build: a packaged build execs its app binary; a dev build
 *  execs Electron on the path it was started on, absolutized against `cwd` so the generated shim
 *  launches the same build from anywhere. */
export function resolveLaunchInvocation(
  execPath: string,
  isDevBuild: boolean,
  startPath: string | undefined,
  cwd: string,
  mainDir: string,
): LaunchInvocation {
  if (!isDevBuild || !startPath) return { kind: 'packaged', execPath };
  return { kind: 'development', execPath, startPath: path.resolve(cwd, startPath), mainDir };
}

/**
 * The POSIX shell launch shim (§23.4 / #25). An optional caller-supplied path crosses the OS boundary
 * as one verbatim directory operand, never shell-interpolated (CWE-78). A relative path resolves
 * against the invoking shell's cwd, not the launched process's; the instance starts detached so the
 * shell returns immediately.
 */
export function generateShim(invocation: LaunchInvocation): string {
  const appArgs = invocation.kind === 'development' ? [invocation.startPath] : [];
  const cmd = [invocation.execPath, ...appArgs].map(shellQuote).join(' ');
  return [
    '#!/bin/sh',
    '# agent-terminal launcher (generated, §23.4) — reinstalling reconciles it to the current build.',
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
