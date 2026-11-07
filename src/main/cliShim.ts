// agent-terminal launch shim generation (§23.4 / #25).

import fs from 'node:fs';
import path from 'node:path';
import { shellQuote } from '../shared/shellQuote';
import { APP_LAUNCH_DIR_ENV } from './launchRoot';

/** The AppImage the running app may have been started from: the AppImage file and the mount it runs from. */
export interface AppImageFacts {
  appImage: string;
  mountDir: string;
}

/** The launch invocation a generated shim execs to start a fresh, independent instance: the app
 *  binary plus the args needed to load this build (none when packaged, the main script in dev), or
 *  the AppImage file itself, whose mount disappears when the app exits. */
export type LaunchInvocation = BinaryInvocation | { appImage: string };

export interface BinaryInvocation {
  execPath: string;
  appArgs: string[];
}

/** The installed command's filename. */
export const CLI_COMMAND_NAME = 'agent-terminal';

export const CONTROLLER_FLAG = '--controller';
export const CONTROLLER_PRODUCT_NAME = 'agent-terminal-controller';
export const CONTROLLER_OUTPUT_SUBDIR = 'controller';

const DEV_CONTROLLER_ENTRY = 'controller.js';
export const TERMINAL_APPIMAGE_PREFIX = 'agent-terminal';
const MAC_BUNDLE_BINARY = /^(.*)\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/;

/** Where the controller of the same build as `invocation` may be: for an AppImage, only the sibling file
 *  whose name replaces the leading `agent-terminal` with `agent-terminal-controller` (none without that
 *  prefix); otherwise installed beside the terminal (/Applications, /opt), then in the controller
 *  package's build output beside the terminal's. */
export function controllerInvocations(invocation: LaunchInvocation): BinaryInvocation[] {
  if ('appImage' in invocation) {
    const name = path.basename(invocation.appImage);
    if (!name.startsWith(TERMINAL_APPIMAGE_PREFIX)) return [];
    const sibling = CONTROLLER_PRODUCT_NAME + name.slice(TERMINAL_APPIMAGE_PREFIX.length);
    return [{ execPath: path.join(path.dirname(invocation.appImage), sibling), appArgs: [] }];
  }
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
  const looked =
    'appImage' in invocation && candidates.length === 0
      ? path.dirname(invocation.appImage)
      : candidates.map((c) => c.appArgs[0] ?? c.execPath).join(', ');
  return [
    `if [ "$#" -ge 1 ] && [ "$1" = ${CONTROLLER_FLAG} ]; then`,
    ...launches,
    `  printf '%s\\n' ${shellQuote(`${CLI_COMMAND_NAME}: no controller app found (looked for ${looked})`)} >&2`,
    '  exit 1',
    'fi',
  ];
}

function realOrRaw(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** How to launch a fresh instance of this build: when the running binary is inside the AppImage mount,
 *  the AppImage file itself, since the mount exists only while the app runs; otherwise a packaged build
 *  execs its app binary with no extra args, and a dev build (Electron loading a main script) execs
 *  Electron with that script, absolutized against `cwd` so the generated shim launches the same build
 *  from anywhere. */
export function resolveLaunchInvocation(
  execPath: string,
  isDevBuild: boolean,
  mainScript: string | undefined,
  cwd: string,
  appImage?: AppImageFacts,
): LaunchInvocation {
  if (appImage && path.isAbsolute(appImage.appImage) && path.isAbsolute(appImage.mountDir)) {
    // On Linux process.execPath is symlink-resolved while the AppImage runtime's APPDIR is not.
    const rel = path.relative(realOrRaw(appImage.mountDir), realOrRaw(execPath));
    if (rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) {
      return { appImage: appImage.appImage };
    }
  }
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
  const { execPath, appArgs } = 'appImage' in invocation ? { execPath: invocation.appImage, appArgs: [] } : invocation;
  const cmd = [execPath, ...appArgs].map(shellQuote).join(' ');
  const appImageGone =
    'appImage' in invocation
      ? [
          `if [ ! -f ${shellQuote(invocation.appImage)} ]; then`,
          `  printf '%s\\n' ${shellQuote(`${CLI_COMMAND_NAME}: ${invocation.appImage} is gone; reinstall the command from Settings → Command line → Install`)} >&2`,
          '  exit 1',
          'fi',
        ]
      : [];
  const appImageNotExecutable =
    'appImage' in invocation
      ? [
          `if [ ! -x ${shellQuote(invocation.appImage)} ]; then`,
          `  printf '%s\\n' ${shellQuote(`${CLI_COMMAND_NAME}: ${invocation.appImage} is not executable; make it executable (chmod +x ${shellQuote(invocation.appImage)}) and run the command again`)} >&2`,
          '  exit 1',
          'fi',
        ]
      : [];
  return [
    '#!/bin/sh',
    '# agent-terminal launcher (generated, §23.4) — reinstalling reconciles it to the current build.',
    ...appImageGone,
    ...controllerBranch(invocation),
    ...appImageNotExecutable,
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
