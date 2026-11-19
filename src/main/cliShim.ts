import path from 'node:path';
import { shellQuote } from '../shared/shellQuote';
import { APP_LAUNCH_DIR_ENV } from './launchRoot';

export interface AppImageFacts {
  appImage: string;
  mountDir: string;
}

export type LaunchInvocation =
  | { kind: 'packaged'; execPath: string }
  | {
      kind: 'development';
      execPath: string;
      /** Under electron-vite dev this is the app root, not the main bundle, so the controller entry is
       *  never derived from it. */
      startPath: string;
      mainDir: string;
    }
  | { kind: 'appImage'; appImage: string };

interface ShimCommand {
  execPath: string;
  args: string[];
}

export const CLI_COMMAND_NAME = 'agent-terminal';

export const CONTROLLER_FLAG = '--controller';
export const CONTROLLER_PRODUCT_NAME = 'agent-terminal-controller';
export const CONTROLLER_OUTPUT_SUBDIR = 'controller';

const DEV_CONTROLLER_ENTRY = 'controller.js';
export const TERMINAL_APPIMAGE_PREFIX = 'agent-terminal';
const MAC_BUNDLE_BINARY = /^(.*)\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/;

interface ControllerLookup {
  candidates: ShimCommand[];
  looked: string;
}

function binaryControllerCandidates(invocation: Exclude<LaunchInvocation, { kind: 'appImage' }>): ShimCommand[] {
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

function controllerLookup(invocation: LaunchInvocation): ControllerLookup {
  switch (invocation.kind) {
    case 'packaged':
    case 'development': {
      const candidates = binaryControllerCandidates(invocation);
      return { candidates, looked: candidates.map((c) => c.args[0] ?? c.execPath).join(', ') };
    }
    case 'appImage': {
      const folder = path.dirname(invocation.appImage);
      const name = path.basename(invocation.appImage);
      if (!name.startsWith(TERMINAL_APPIMAGE_PREFIX)) return { candidates: [], looked: folder };
      const sibling = path.join(folder, CONTROLLER_PRODUCT_NAME + name.slice(TERMINAL_APPIMAGE_PREFIX.length));
      return { candidates: [{ execPath: sibling, args: [] }], looked: sibling };
    }
    default:
      return invocation satisfies never;
  }
}

function controllerBranch(invocation: LaunchInvocation): string[] {
  const { candidates, looked } = controllerLookup(invocation);
  const launches = candidates.map(({ execPath, args }) => {
    const present = [`[ -x ${shellQuote(execPath)} ]`, ...args.map((a) => `[ -f ${shellQuote(a)} ]`)];
    const cmd = [execPath, ...args].map(shellQuote).join(' ');
    return `  if ${present.join(' && ')}; then nohup ${cmd} >/dev/null 2>&1 & exit 0; fi`;
  });
  return [
    `if [ "$#" -ge 1 ] && [ "$1" = ${CONTROLLER_FLAG} ]; then`,
    ...launches,
    `  printf '%s\\n' ${shellQuote(`${CLI_COMMAND_NAME}: no controller app found (looked for ${looked})`)} >&2`,
    '  exit 1',
    'fi',
  ];
}

/** An AppImage's mount exists only while the app runs, so a command for one launches the AppImage file.
 *  A dev build execs Electron on the path it was started on, absolutized against `cwd` so the
 *  generated shim launches the same build from anywhere. */
export function resolveLaunchInvocation(
  execPath: string,
  isDevBuild: boolean,
  startPath: string | undefined,
  cwd: string,
  mainDir: string,
  appImage?: AppImageFacts,
): LaunchInvocation {
  if (appImage && path.isAbsolute(appImage.appImage) && path.isAbsolute(appImage.mountDir)) {
    const rel = path.relative(appImage.mountDir, execPath);
    if (rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
      return { kind: 'appImage', appImage: appImage.appImage };
    }
  }
  if (!isDevBuild || !startPath) return { kind: 'packaged', execPath };
  return { kind: 'development', execPath, startPath: path.resolve(cwd, startPath), mainDir };
}

function shimParts(invocation: LaunchInvocation): { cmd: string; before: string[]; afterController: string[] } {
  switch (invocation.kind) {
    case 'packaged':
      return { cmd: shellQuote(invocation.execPath), before: [], afterController: [] };
    case 'development':
      return { cmd: [invocation.execPath, invocation.startPath].map(shellQuote).join(' '), before: [], afterController: [] };
    case 'appImage': {
      const file = shellQuote(invocation.appImage);
      const fail = (message: string): string[] => [
        `  printf '%s\\n' ${shellQuote(`${CLI_COMMAND_NAME}: ${invocation.appImage} ${message}`)} >&2`,
        '  exit 1',
        'fi',
      ];
      return {
        cmd: file,
        before: [`if [ ! -f ${file} ]; then`, ...fail('is gone; reinstall the command from Settings → Command line → Install')],
        afterController: [
          `if [ ! -x ${file} ]; then`,
          ...fail(`is not executable; make it executable (chmod +x ${file}) and run the command again`),
        ],
      };
    }
    default:
      return invocation satisfies never;
  }
}

/** CWE-78: the caller's directory reaches the app as one environment value, never as shell text. */
export function generateShim(invocation: LaunchInvocation): string {
  const { cmd, before, afterController } = shimParts(invocation);
  return [
    '#!/bin/sh',
    '# agent-terminal launcher (generated, §23.4) — reinstalling reconciles it to the current build.',
    ...before,
    ...controllerBranch(invocation),
    ...afterController,
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
