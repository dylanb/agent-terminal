import path from 'node:path';
import { shellQuote } from '../shared/shellQuote';
import { APP_LAUNCH_DIR_ENV } from './launchRoot';

export interface AppImageFacts {
  appImage: string;
  mountDir: string;
}

export type LaunchInvocation = BinaryInvocation | { kind: 'appImage'; appImage: string };

export interface BinaryInvocation {
  kind: 'binary';
  execPath: string;
  appArgs: string[];
}

export const CLI_COMMAND_NAME = 'agent-terminal';

export const CONTROLLER_FLAG = '--controller';
export const VALIDATE_FLOW_FLAG = '--validate-flow';
export const CHECK_REPEAT_LIST_FLAG = '--check-repeat-list';
export const CONTROLLER_PRODUCT_NAME = 'agent-terminal-controller';
export const CONTROLLER_OUTPUT_SUBDIR = 'controller';

const DEV_CONTROLLER_ENTRY = 'controller.js';
export const TERMINAL_APPIMAGE_PREFIX = 'agent-terminal';
const MAC_BUNDLE_BINARY = /^(.*)\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/;

interface ControllerLookup {
  candidates: BinaryInvocation[];
  looked: string;
}

const binary = (execPath: string, appArgs: string[] = []): BinaryInvocation => ({ kind: 'binary', execPath, appArgs });

function binaryControllerCandidates(invocation: BinaryInvocation): BinaryInvocation[] {
  const [mainScript] = invocation.appArgs;
  if (mainScript) return [binary(invocation.execPath, [path.join(path.dirname(mainScript), DEV_CONTROLLER_ENTRY)])];
  const mac = MAC_BUNDLE_BINARY.exec(invocation.execPath);
  const hostDir = mac ? mac[1] : path.dirname(invocation.execPath);
  const binaryIn = (dir: string): string =>
    mac
      ? path.join(dir, `${CONTROLLER_PRODUCT_NAME}.app`, 'Contents', 'MacOS', CONTROLLER_PRODUCT_NAME)
      : path.join(dir, CONTROLLER_PRODUCT_NAME);
  const installed = mac ? hostDir : path.join(path.dirname(hostDir), CONTROLLER_PRODUCT_NAME);
  const built = path.join(path.dirname(hostDir), CONTROLLER_OUTPUT_SUBDIR, path.basename(hostDir));
  return [installed, built].map((dir) => binary(binaryIn(dir)));
}

function controllerLookup(invocation: LaunchInvocation): ControllerLookup {
  switch (invocation.kind) {
    case 'binary': {
      const candidates = binaryControllerCandidates(invocation);
      return { candidates, looked: candidates.map((c) => c.appArgs[0] ?? c.execPath).join(', ') };
    }
    case 'appImage': {
      const folder = path.dirname(invocation.appImage);
      const name = path.basename(invocation.appImage);
      if (!name.startsWith(TERMINAL_APPIMAGE_PREFIX)) return { candidates: [], looked: folder };
      const sibling = path.join(folder, CONTROLLER_PRODUCT_NAME + name.slice(TERMINAL_APPIMAGE_PREFIX.length));
      return { candidates: [binary(sibling)], looked: sibling };
    }
    default:
      return invocation satisfies never;
  }
}

function controllerBranch(invocation: LaunchInvocation): string[] {
  const { candidates, looked } = controllerLookup(invocation);
  const launches = candidates.map(({ execPath, appArgs }) => {
    const present = [`[ -x ${shellQuote(execPath)} ]`, ...appArgs.map((a) => `[ -f ${shellQuote(a)} ]`)];
    const cmd = [execPath, ...appArgs].map(shellQuote).join(' ');
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

/** An AppImage's mount exists only while the app runs, so a command for one launches the AppImage file. */
export function resolveLaunchInvocation(
  execPath: string,
  isDevBuild: boolean,
  mainScript: string | undefined,
  cwd: string,
  appImage?: AppImageFacts,
): LaunchInvocation {
  if (appImage && path.isAbsolute(appImage.appImage) && path.isAbsolute(appImage.mountDir)) {
    const rel = path.relative(appImage.mountDir, execPath);
    if (rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
      return { kind: 'appImage', appImage: appImage.appImage };
    }
  }
  const appArgs = isDevBuild && mainScript ? [path.resolve(cwd, mainScript)] : [];
  return binary(execPath, appArgs);
}

// A dev build's main script is deliberately left out: in plain-Node mode the checker script is the program.
function checkerBranch(flag: string, invocation: LaunchInvocation, checkerScript: string): string[] {
  const command = invocation.kind === 'binary'
    ? [invocation.execPath, checkerScript]
    : [invocation.appImage, '-e', "require(process.env.APPDIR + '/resources/app.asar/out/main/artifactCheck.js')", 'artifactCheck'];
  return [
    `if [ "$#" -ge 1 ] && [ "$1" = ${shellQuote(flag)} ]; then`,
    '  ELECTRON_RUN_AS_NODE=1',
    '  export ELECTRON_RUN_AS_NODE',
    `  exec ${command.map(shellQuote).join(' ')} "$@"`,
    'fi',
  ];
}

function shimParts(invocation: LaunchInvocation): { cmd: string; before: string[]; afterController: string[] } {
  switch (invocation.kind) {
    case 'binary':
      return { cmd: [invocation.execPath, ...invocation.appArgs].map(shellQuote).join(' '), before: [], afterController: [] };
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
export function generateShim(invocation: LaunchInvocation, checkerScript: string): string {
  const { cmd, before, afterController } = shimParts(invocation);
  return [
    '#!/bin/sh',
    '# agent-terminal launcher (generated, §23.4) — reinstalling reconciles it to the current build.',
    ...before,
    ...checkerBranch(VALIDATE_FLOW_FLAG, invocation, checkerScript),
    ...checkerBranch(CHECK_REPEAT_LIST_FLAG, invocation, checkerScript),
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
